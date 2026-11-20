import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { Pool } from 'pg';
import { PG_POOL, PRISMA } from '../../infra/tokens.js';
import { createVenue, getGeometry, getVenue, listVenues, type Geometry, type VenueView } from './domain/venues-repo.js';
import type { VenueLayout } from '@ticketing/shared';

@Injectable()
export class VenuesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  create = (organizerId: string, layout: VenueLayout): Promise<VenueView> => createVenue(this.prisma, organizerId, layout);
  list = (organizerId: string): Promise<readonly VenueView[]> => listVenues(this.pool, organizerId);
  get = (organizerId: string, id: string): Promise<VenueView | null> => getVenue(this.pool, organizerId, id);
  geometry = (organizerId: string, id: string): Promise<Geometry | null> => getGeometry(this.pool, organizerId, id);
}
