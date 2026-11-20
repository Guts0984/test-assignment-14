import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ApiErrors } from '../../common/api-errors.decorator.js';
import { AppException, unwrap } from '../../common/app.exception.js';
import { CurrentUser, Roles, type AuthUser } from '../../common/decorators.js';
import { QueueViewDto } from '../../common/flows.dto.js';
import { appError } from '../../common/result.js';
import { QueueService } from './queue.service.js';

const notInQueue = (): AppException => new AppException(appError('NOT_FOUND', 'You are not in the queue for this event'));

@ApiTags('queue')
@ApiBearerAuth()
@ApiErrors()
@Roles('buyer')
@Controller('events/:eventId/queue')
export class QueueController {
  constructor(private readonly queue: QueueService) {}

  @Post()
  @HttpCode(200)
  @ApiOkResponse({ type: QueueViewDto })
  async join(@CurrentUser() user: AuthUser, @Param('eventId', ParseUUIDPipe) eventId: string): Promise<QueueViewDto> {
    return unwrap(await this.queue.join(eventId, user.id));
  }

  @Get()
  @ApiOkResponse({ type: QueueViewDto })
  async view(@CurrentUser() user: AuthUser, @Param('eventId', ParseUUIDPipe) eventId: string): Promise<QueueViewDto> {
    return (await this.queue.view(eventId, user.id)) ?? Promise.reject(notInQueue());
  }

  @Delete()
  @ApiOkResponse({ type: QueueViewDto })
  async leave(@CurrentUser() user: AuthUser, @Param('eventId', ParseUUIDPipe) eventId: string): Promise<QueueViewDto> {
    return (await this.queue.leave(eventId, user.id)) ?? Promise.reject(notInQueue());
  }
}
