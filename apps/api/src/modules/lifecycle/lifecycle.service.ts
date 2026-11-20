import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { RealtimePublisher } from '@ticketing/platform';
import { PG_POOL, RT_PUBLISHER } from '../../infra/tokens.js';
import { assignStaff, cancelEvent, cancellationProgress, listStaff, rescheduleEvent } from './domain/lifecycle.js';

@Injectable()
export class LifecycleService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(RT_PUBLISHER) private readonly rt: RealtimePublisher,
  ) {}

  async reschedule(organizerId: string, eventId: string, startsAt: string) {
    const r = await rescheduleEvent(this.pool, organizerId, eventId, startsAt);
    if (r.ok) this.rt.toEventAdmins(eventId, 'event.updated', { eventId, status: 'rescheduled' });
    return r;
  }

  async cancel(organizerId: string, eventId: string) {
    const r = await cancelEvent(this.pool, organizerId, eventId);
    if (r.ok) {
      this.rt.seatsChanged(eventId);
      this.rt.toEventAdmins(eventId, 'event.cancelled', { eventId });
    }
    return r;
  }

  progress = (organizerId: string, eventId: string) => cancellationProgress(this.pool, organizerId, eventId);
  assign = (organizerId: string, eventId: string, email: string) => assignStaff(this.pool, organizerId, eventId, email);
  staff = (organizerId: string, eventId: string) => listStaff(this.pool, organizerId, eventId);
}
