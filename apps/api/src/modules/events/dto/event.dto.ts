import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  blockSeatsRequestSchema, createEventRequestSchema, eventDetailSchema, eventSearchQuerySchema, eventSearchResponseSchema,
  seatLayoutSchema, seatStateSchema, updateEventRequestSchema, uuidSchema,
} from '@ticketing/shared';

export class CreateEventDto extends createZodDto(createEventRequestSchema) {}
export class UpdateEventDto extends createZodDto(updateEventRequestSchema) {}
export class BlockSeatsDto extends createZodDto(blockSeatsRequestSchema) {}
export class EventSearchQueryDto extends createZodDto(eventSearchQuerySchema) {}
export class EventSearchResponseDto extends createZodDto(eventSearchResponseSchema) {}
export class EventDetailDto extends createZodDto(eventDetailSchema) {}
export class SeatLayoutDto extends createZodDto(seatLayoutSchema) {}
export class SeatStateDto extends createZodDto(seatStateSchema) {}
export class CreatedEventDto extends createZodDto(z.object({ id: uuidSchema })) {}
export class OkDto extends createZodDto(z.object({ ok: z.literal(true) })) {}
export class BlockedResultDto extends createZodDto(z.object({ changed: z.number().int() })) {}
