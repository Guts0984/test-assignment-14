import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ApiErrors } from '../../common/api-errors.decorator.js';
import { AppException } from '../../common/app.exception.js';
import { CurrentUser, Roles, type AuthUser } from '../../common/decorators.js';
import { ScannerEventListDto, ScanRequestDto, ScanResultDto, ScanStatsDto } from '../../common/flows.dto.js';
import { appError } from '../../common/result.js';
import { ScanningService } from './scanning.service.js';

@ApiTags('scanner')
@ApiBearerAuth()
@ApiErrors()
@Roles('scanner')
@Controller('scanner')
export class ScanningController {
  constructor(private readonly scanning: ScanningService) {}

  private async guard(user: AuthUser, eventId: string): Promise<void> {
    if (!(await this.scanning.assigned(eventId, user.id))) throw new AppException(appError('NOT_FOUND', 'Event not found'));
  }

  @Get('events')
  @ApiOkResponse({ type: ScannerEventListDto })
  async events(@CurrentUser() user: AuthUser): Promise<ScannerEventListDto> {
    return { items: await this.scanning.events(user.id) };
  }

  @Post('events/:eventId/scan')
  @HttpCode(200)
  @ApiOkResponse({ type: ScanResultDto })
  async scan(@CurrentUser() user: AuthUser, @Param('eventId', ParseUUIDPipe) eventId: string, @Body() body: ScanRequestDto): Promise<ScanResultDto> {
    await this.guard(user, eventId);
    return this.scanning.scan(eventId, user.id, body.code, body.gate);
  }

  @Get('events/:eventId/stats')
  @ApiOkResponse({ type: ScanStatsDto })
  async stats(@CurrentUser() user: AuthUser, @Param('eventId', ParseUUIDPipe) eventId: string): Promise<ScanStatsDto> {
    await this.guard(user, eventId);
    return this.scanning.stats(eventId);
  }
}
