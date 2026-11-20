import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ApiErrors } from '../../common/api-errors.decorator.js';
import { unwrap } from '../../common/app.exception.js';
import { CurrentUser, Roles, type AuthUser } from '../../common/decorators.js';
import { WaitlistRequestDto, WaitlistStatusDto } from '../../common/flows.dto.js';
import { WaitlistService } from './waitlist.service.js';

@ApiTags('waitlist')
@ApiBearerAuth()
@ApiErrors()
@Roles('buyer')
@Controller('events/:eventId/waitlist')
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Post()
  @HttpCode(200)
  @ApiOkResponse({ type: WaitlistStatusDto })
  async join(@CurrentUser() user: AuthUser, @Param('eventId', ParseUUIDPipe) eventId: string, @Body() body: WaitlistRequestDto): Promise<WaitlistStatusDto> {
    return unwrap(await this.waitlist.join(eventId, user.id, body.zoneId));
  }

  @Get()
  @ApiOkResponse({ type: WaitlistStatusDto })
  status(@CurrentUser() user: AuthUser, @Param('eventId', ParseUUIDPipe) eventId: string): Promise<WaitlistStatusDto> {
    return this.waitlist.status(eventId, user.id);
  }

  @Delete()
  @ApiOkResponse({ type: WaitlistStatusDto })
  leave(@CurrentUser() user: AuthUser, @Param('eventId', ParseUUIDPipe) eventId: string): Promise<WaitlistStatusDto> {
    return this.waitlist.leave(eventId, user.id);
  }
}
