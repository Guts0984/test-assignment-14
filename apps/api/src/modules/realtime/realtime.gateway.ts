import { Inject, Logger } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayConnection, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Pool } from 'pg';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { adminRoom, eventRoom, loadChanges, userRoom, type Redis } from '@ticketing/platform';
import type { Role } from '@ticketing/shared';
import type { Env } from '../../config/env.schema.js';
import { ENV, PG_POOL, REDIS } from '../../infra/tokens.js';
import { isSessionActive } from '../auth/domain/sessions.js';
import { verifyAccessToken } from '../auth/domain/tokens.js';

interface SocketUser {
  readonly id: string;
  readonly role: Role;
}

const subscribeSchema = z.object({ eventId: z.string().uuid(), lastSeq: z.number().int().min(0).optional(), admin: z.boolean().optional() }).strict();

const CATCH_UP_LIMIT = 5_000;

/**
 * Socket.IO gateway. Every connection is authenticated (JWT in the handshake, session must be alive). The server -
 * never the client - decides which rooms a socket may join: its own `user:<id>` room automatically, a public
 * `event:<id>` room when the event is published (or the viewer owns it), and `admin:<id>` for the organizer of the event.
 * Events travel between api copies through the Redis adapter.
 */
@WebSocketGateway({ cors: false })
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger('realtime');

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  afterInit(server: Server): void {
    server.adapter(createAdapter(this.redis.duplicate(), this.redis.duplicate()));
    server.use((socket, next) => {
      void this.authenticate(socket)
        .then((user) => {
          if (!user) return next(new Error('unauthorized'));
          socket.data['user'] = user;
          next();
        })
        .catch(() => next(new Error('unauthorized')));
    });
  }

  private async authenticate(socket: Socket): Promise<SocketUser | null> {
    const token: unknown = (socket.handshake.auth as Record<string, unknown> | undefined)?.['token'];
    if (typeof token !== 'string' || token.length === 0 || token.length > 4_000) return null;
    const claims = await verifyAccessToken(this.env.JWT_ACCESS_SECRET, token);
    if (!claims || !(await isSessionActive(this.pool, claims.sid))) return null;
    return { id: claims.sub, role: claims.role };
  }

  handleConnection(socket: Socket): void {
    const user = socket.data['user'] as SocketUser | undefined;
    if (!user) return void socket.disconnect(true);
    void socket.join(userRoom(user.id));
    const stamps: number[] = [];
    socket.use((_packet, next) => {
      const now = Date.now();
      while (stamps.length > 0 && now - (stamps[0] ?? 0) > 1_000) stamps.shift();
      stamps.push(now);
      if (stamps.length > this.env.WS_MAX_MSGS_PER_SEC) {
        if (stamps.length > this.env.WS_MAX_MSGS_PER_SEC * 3) socket.disconnect(true);
        return next(new Error('rate limited'));
      }
      next();
    });
  }

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const user = socket.data['user'] as SocketUser | undefined;
    const parsed = subscribeSchema.safeParse(body);
    if (!user || !parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
    const { eventId, lastSeq, admin } = parsed.data;
    const ev = (await this.pool.query<{ organizer_id: string; status: string; seat_seq: string }>(`SELECT organizer_id, status, seat_seq FROM events WHERE id = $1`, [eventId])).rows[0];
    const owner = ev?.organizer_id === user.id;
    if (!ev || (ev.status === 'draft' && !owner)) return { ok: false, code: 'NOT_FOUND' };
    if (admin) {
      if (!owner || user.role !== 'organizer') return { ok: false, code: 'NOT_FOUND' };
      await socket.join(adminRoom(eventId));
    }
    await socket.join(eventRoom(eventId));
    const head = Number(ev.seat_seq);
    const now = (await this.pool.query<{ now: Date }>(`SELECT app_now() AS now`)).rows[0]?.now ?? new Date();
    if (lastSeq === undefined) return { ok: true, seq: head, serverTime: now.toISOString(), changes: [] };
    if (head - lastSeq > CATCH_UP_LIMIT) return { ok: true, seq: head, serverTime: now.toISOString(), resync: true, changes: [] };
    // Reads happen after the room join, so nothing between the catch-up and the live stream can be missed;
    // clients drop anything at or below the sequence they already hold.
    return { ok: true, seq: head, serverTime: now.toISOString(), changes: await loadChanges(this.pool, eventId, lastSeq, CATCH_UP_LIMIT) };
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const parsed = z.object({ eventId: z.string().uuid() }).strict().safeParse(body);
    if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
    await socket.leave(eventRoom(parsed.data.eventId));
    await socket.leave(adminRoom(parsed.data.eventId));
    return { ok: true };
  }
}
