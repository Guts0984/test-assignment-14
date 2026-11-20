import { createZodDto } from 'nestjs-zod';
import { venueGeometrySchema, venueLayoutSchema, venueListSchema, venueSchema } from '@ticketing/shared';

export class VenueLayoutDto extends createZodDto(venueLayoutSchema) {}
export class VenueDto extends createZodDto(venueSchema) {}
export class VenueListDto extends createZodDto(venueListSchema) {}
export class VenueGeometryDto extends createZodDto(venueGeometrySchema) {}
