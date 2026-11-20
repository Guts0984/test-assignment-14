import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { idempotencyKeySchema } from '@ticketing/shared';
import { ApiErrors } from '../../common/api-errors.decorator.js';
import { AppException, unwrap } from '../../common/app.exception.js';
import { CurrentUser, Roles, type AuthUser } from '../../common/decorators.js';
import { TicketDto, TicketListDto, TransferRequestDto } from '../../common/flows.dto.js';
import { appError } from '../../common/result.js';
import { TicketsService } from './tickets.service.js';

@ApiTags('tickets')
@ApiBearerAuth()
@ApiErrors()
@Roles('buyer')
@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  @ApiOkResponse({ type: TicketListDto })
  async list(@CurrentUser() user: AuthUser): Promise<TicketListDto> {
    return { items: (await this.tickets.list(user.id)) as unknown as TicketListDto['items'] };
  }

  @Get(':id')
  @ApiOkResponse({ type: TicketDto })
  async get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<TicketDto> {
    return ((await this.tickets.get(id, user.id)) as unknown as TicketDto | null) ?? Promise.reject(new AppException(appError('NOT_FOUND', 'Ticket not found')));
  }

  @Post(':id/transfer')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: TicketDto })
  async transfer(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: TransferRequestDto, @Headers('idempotency-key') raw: string | undefined): Promise<TicketDto> {
    const key = idempotencyKeySchema.safeParse(raw);
    if (!key.success) throw new AppException(appError('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-128 URL-safe characters)'));
    return unwrap(await this.tickets.transfer({ ticketId: id, fromUserId: user.id, toEmail: body.email, key: key.data })) as unknown as TicketDto;
  }
}
