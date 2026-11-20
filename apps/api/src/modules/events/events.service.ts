import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { RealtimePublisher } from '@ticketing/platform';
import { PG_POOL, RT_PUBLISHER } from '../../infra/tokens.js';
import type { Result } from '../../common/result.js';
import type { SearchParams } from './domain/search-query.js';
import { getEventDetail, listOrganizerEvents, searchEvents } from './repo/queries.js';
import { getSeatLayout, getSeatState } from './repo/seatmap.js';
import { createEvent, publishEvent, setBlocked, updateEvent, type EventDraftInput, type EventPatch } from './repo/write.js';

@Injectable()
export class EventsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(RT_PUBLISHER) private readonly rt: RealtimePublisher,
  ) {}

  search = (params: SearchParams) => searchEvents(this.pool, params);
  detail = (id: string, viewerId: string | null) => getEventDetail(this.pool, id, viewerId);
  mine = (organizerId: string) => listOrganizerEvents(this.pool, organizerId);
  create = (organizerId: string, venueId: string, input: EventDraftInput): Promise<Result<{ readonly id: string }>> => createEvent(this.pool, organizerId, venueId, input);
  update = (organizerId: string, id: string, patch: EventPatch) => updateEvent(this.pool, organizerId, id, patch);
  publish = (organizerId: string, id: string) => publishEvent(this.pool, organizerId, id);
  async block(organizerId: string, id: string, seatIds: readonly number[], blocked: boolean) {
    const r = await setBlocked(this.pool, organizerId, id, seatIds, blocked);
    if (r.ok) this.rt.seatsChanged(id);
    return r;
  }

  /** Visible when published, or when the viewer is the organizer. */
  async layout(id: string, viewerId: string | null) {
    return (await getEventDetail(this.pool, id, viewerId)) ? getSeatLayout(this.pool, id) : null;
  }
  async state(id: string, viewerId: string | null) {
    return (await getEventDetail(this.pool, id, viewerId)) ? getSeatState(this.pool, id) : null;
  }
}
