import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ApiErrors } from '../../common/api-errors.decorator.js';
import { AppException, unwrap } from '../../common/app.exception.js';
import { CurrentUser, Roles, type AuthUser } from '../../common/decorators.js';
import { CancellationProgressDto, RescheduleRequestDto, StaffListDto, StaffRequestDto } from '../../common/flows.dto.js';
import { appError } from '../../common/result.js';
import { OkDto } from '../events/dto/event.dto.js';
import { LifecycleService } from './lifecycle.service.js';

@ApiTags('organizer')
@ApiBearerAuth()
@ApiErrors()
@Roles('organizer')
@Controller('organizer/events/:id')
export class LifecycleController {
  constructor(private readonly lifecycle: LifecycleService) {}

  @Post('reschedule')
  @HttpCode(200)
  @ApiOkResponse({ type: OkDto })
  async reschedule(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: RescheduleRequestDto): Promise<OkDto> {
    unwrap(await this.lifecycle.reschedule(user.id, id, body.startsAt));
    return { ok: true };
  }

  /** Stops sales at once and refunds every order in the background. Calling it again changes nothing. */
  @Post('cancel')
  @HttpCode(200)
  @ApiOkResponse({ type: CancellationProgressDto })
  async cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<CancellationProgressDto> {
    unwrap(await this.lifecycle.cancel(user.id, id));
    return this.progress(user, id);
  }

  @Get('cancellation')
  @ApiOkResponse({ type: CancellationProgressDto })
  async progress(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<CancellationProgressDto> {
    return (await this.lifecycle.progress(user.id, id)) ?? Promise.reject(new AppException(appError('NOT_FOUND', 'Event not found')));
  }

  @Post('staff')
  @HttpCode(200)
  @ApiOkResponse({ type: OkDto })
  async assign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: StaffRequestDto): Promise<OkDto> {
    unwrap(await this.lifecycle.assign(user.id, id, body.email));
    return { ok: true };
  }

  @Get('staff')
  @ApiOkResponse({ type: StaffListDto })
  async staff(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<StaffListDto> {
    return { items: await this.lifecycle.staff(user.id, id) };
  }
}
