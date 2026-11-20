import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  cancellationProgressSchema, checkoutResponseSchema, financeRefundRequestSchema, financeReportSchema, jobListSchema, organizerSalesQuerySchema,
  organizerSalesSchema, periodQuerySchema, queueViewSchema, reconciliationSchema, refundQuoteSchema, refundRequestSchema, refundSchema,
  rescheduleRequestSchema, scanRequestSchema, scanResultSchema, scanStatsSchema, scannerEventListSchema, staffRequestSchema, ticketListSchema,
  ticketSchema, transferRequestSchema, uuidSchema, waitlistRequestSchema, waitlistStatusSchema,
} from '@ticketing/shared';

export class CheckoutResponseDto extends createZodDto(checkoutResponseSchema) {}
export class RefundRequestDto extends createZodDto(refundRequestSchema) {}
export class FinanceRefundRequestDto extends createZodDto(financeRefundRequestSchema) {}
export class RefundQuoteDto extends createZodDto(refundQuoteSchema) {}
export class RefundDto extends createZodDto(refundSchema) {}
export class RefundListDto extends createZodDto(z.object({ items: z.array(refundSchema) })) {}
export class TicketDto extends createZodDto(ticketSchema) {}
export class TicketListDto extends createZodDto(ticketListSchema) {}
export class TransferRequestDto extends createZodDto(transferRequestSchema) {}
export class ScanRequestDto extends createZodDto(scanRequestSchema) {}
export class ScanResultDto extends createZodDto(scanResultSchema) {}
export class ScanStatsDto extends createZodDto(scanStatsSchema) {}
export class ScannerEventListDto extends createZodDto(scannerEventListSchema) {}
export class StaffRequestDto extends createZodDto(staffRequestSchema) {}
export class StaffListDto extends createZodDto(z.object({ items: z.array(z.object({ userId: uuidSchema, email: z.string(), displayName: z.string() })) })) {}
export class WaitlistRequestDto extends createZodDto(waitlistRequestSchema) {}
export class WaitlistStatusDto extends createZodDto(waitlistStatusSchema) {}
export class QueueViewDto extends createZodDto(queueViewSchema) {}
export class RescheduleRequestDto extends createZodDto(rescheduleRequestSchema) {}
export class CancellationProgressDto extends createZodDto(cancellationProgressSchema) {}
export class PeriodQueryDto extends createZodDto(periodQuerySchema) {}
export class OrganizerSalesQueryDto extends createZodDto(organizerSalesQuerySchema) {}
export class OrganizerSalesDto extends createZodDto(organizerSalesSchema) {}
export class FinanceReportDto extends createZodDto(financeReportSchema) {}
export class ReconciliationDto extends createZodDto(reconciliationSchema) {}
export class JobListDto extends createZodDto(jobListSchema) {}
export class JobQueryDto extends createZodDto(z.object({ status: z.enum(['failed', 'stuck', 'all']).default('failed') })) {}
export class WebhookResultDto extends createZodDto(z.object({ outcome: z.enum(['applied', 'duplicate', 'ignored']) })) {}
export class FindingsDto extends createZodDto(z.object({ found: z.number().int() })) {}
export class RestartDto extends createZodDto(z.object({ restarted: z.boolean() })) {}
