import { Global, Module, type DynamicModule, type OnApplicationShutdown, Inject } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { DEFAULT_QUEUE_CONFIG, createLimiter, createProviderClient, createRealtimePublisher, createRedis, createRedisQueueCache, createVirtualQueue, type Redis } from '@ticketing/platform';
import type { Env } from '../config/env.schema.js';
import { createTrustedProxyMatcher, resolveClientIp } from '../common/client-ip.js';
import type { Request } from 'express';
import { CLIENT_IP, ENV, LIMITER, PG_POOL, PRISMA, PROVIDER, REDIS, RT_PUBLISHER, STUB_LIMITER, VIRTUAL_QUEUE } from './tokens.js';

/** Prisma only serves simple CRUD here; keep its pool small so it never starves the raw-SQL pool of connections. */
const withConnectionLimit = (url: string, limit: number): string => {
  const parsed = new URL(url);
  if (!parsed.searchParams.has('connection_limit')) parsed.searchParams.set('connection_limit', String(limit));
  return parsed.toString();
};

@Global()
@Module({})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Clients connect lazily, so the OpenAPI emitter can build the module graph without any infrastructure. */
  static forRoot(env: Env): DynamicModule {
    const providers = [
      { provide: ENV, useValue: env },
      { provide: PG_POOL, useFactory: (): Pool => new Pool({ connectionString: env.DATABASE_URL, max: env.DB_POOL_MAX }) },
      { provide: PRISMA, useFactory: (): PrismaClient => new PrismaClient({ datasourceUrl: withConnectionLimit(env.DATABASE_URL, 4) }) },
      { provide: REDIS, useFactory: (): Redis => createRedis(env.REDIS_URL, { lazyConnect: true, connectionName: env.API_INSTANCE_ID }) },
      {
        provide: CLIENT_IP,
        useFactory: (): ((req: Request) => string) => {
          const trusted = createTrustedProxyMatcher(env.TRUSTED_PROXY_CIDRS);
          return (req) => resolveClientIp({ socketAddress: req.socket.remoteAddress ?? '', forwardedFor: req.headers['x-forwarded-for']?.toString() }, trusted);
        },
      },
      { provide: LIMITER, useFactory: (redis: Redis) => createLimiter(redis, { onError: 'open', timeoutMs: 250 }), inject: [REDIS] },
      { provide: STUB_LIMITER, useFactory: (redis: Redis) => createLimiter(redis, { onError: 'closed', timeoutMs: 400 }), inject: [REDIS] },
      { provide: PROVIDER, useFactory: () => createProviderClient({ baseUrl: env.PAYMENT_PROVIDER_URL, apiKey: env.STUB_API_KEY }) },
      { provide: RT_PUBLISHER, useFactory: (pool: Pool, redis: Redis) => createRealtimePublisher({ pool, redis }), inject: [PG_POOL, REDIS] },
      {
        provide: VIRTUAL_QUEUE,
        useFactory: (pool: Pool, redis: Redis) =>
          createVirtualQueue({ pool, cache: createRedisQueueCache(redis), cfg: { ...DEFAULT_QUEUE_CONFIG, activateAt: env.QUEUE_ACTIVATE_AT, maxSelecting: env.QUEUE_MAX_SELECTING } }),
        inject: [PG_POOL, REDIS],
      },
    ];
    return { module: InfraModule, global: true, providers, exports: providers.map((p) => p.provide) };
  }

  async onApplicationShutdown(): Promise<void> {
    const closeRedis = async (): Promise<void> => {
      if (this.redis.status === 'ready') await this.redis.quit();
      else this.redis.disconnect();
    };
    await Promise.allSettled([this.pool.end(), this.prisma.$disconnect(), closeRedis()]);
  }
}
