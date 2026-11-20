import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ApiErrors } from '../../common/api-errors.decorator.js';
import { AppException, unwrap } from '../../common/app.exception.js';
import { CurrentUser, Public, Roles, type AuthUser } from '../../common/decorators.js';
import { appError } from '../../common/result.js';
import { BlockedResultDto, BlockSeatsDto, CreatedEventDto, CreateEventDto, EventDetailDto, EventSearchQueryDto, EventSearchResponseDto, OkDto, SeatLayoutDto, SeatStateDto, UpdateEventDto } from './dto/event.dto.js';
import { EventsService } from './events.service.js';

const notFound = (): AppException => new AppException(appError('NOT_FOUND', 'Event not found'));
const orNotFound = async <T>(value: Promise<T | null>): Promise<T> => (await value) ?? Promise.reject(notFound());

@ApiTags('events')
@ApiErrors()
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Public()
  @Get()
  @ApiOkResponse({ type: EventSearchResponseDto })
  search(@Query() query: EventSearchQueryDto): Promise<EventSearchResponseDto> {
    return this.events.search(query);
  }

  @Public()
  @Get(':id')
  @ApiOkResponse({ type: EventDetailDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<EventDetailDto> {
    return orNotFound(this.events.detail(id, null));
  }

  @Public()
  @Get(':id/layout')
  @ApiOkResponse({ type: SeatLayoutDto })
  layout(@Param('id', ParseUUIDPipe) id: string): Promise<SeatLayoutDto> {
    return orNotFound(this.events.layout(id, null));
  }

  @Public()
  @Get(':id/seatmap')
  @ApiOkResponse({ type: SeatStateDto })
  seatmap(@Param('id', ParseUUIDPipe) id: string): Promise<SeatStateDto> {
    return orNotFound(this.events.state(id, null));
  }
}

@ApiTags('organizer')
@ApiBearerAuth()
@ApiErrors()
@Roles('organizer')
@Controller('organizer/events')
export class OrganizerEventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  @ApiOkResponse({ type: EventSearchResponseDto })
  mine(@CurrentUser() user: AuthUser): Promise<EventSearchResponseDto> {
    return this.events.mine(user.id);
  }

  @Get(':id')
  @ApiOkResponse({ type: EventDetailDto })
  async get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<EventDetailDto> {
    const found = await this.events.detail(id, user.id);
    return found && found.organizerId === user.id ? found : Promise.reject(notFound());
  }

  @Get(':id/layout')
  @ApiOkResponse({ type: SeatLayoutDto })
  async layout(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<SeatLayoutDto> {
    await this.get(user, id);
    return orNotFound(this.events.layout(id, user.id));
  }

  @Get(':id/seatmap')
  @ApiOkResponse({ type: SeatStateDto })
  async seatmap(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<SeatStateDto> {
    await this.get(user, id);
    return orNotFound(this.events.state(id, user.id));
  }

  @Post()
  @ApiOkResponse({ type: CreatedEventDto })
  async create(@CurrentUser() user: AuthUser, @Body() body: CreateEventDto): Promise<CreatedEventDto> {
    const { venueId, ...draft } = body;
    return unwrap(await this.events.create(user.id, venueId, draft));
  }

  @Patch(':id')
  @ApiOkResponse({ type: OkDto })
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateEventDto): Promise<OkDto> {
    unwrap(await this.events.update(user.id, id, body));
    return { ok: true };
  }

  @Post(':id/publish')
  @HttpCode(200)
  @ApiOkResponse({ type: OkDto })
  async publish(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<OkDto> {
    unwrap(await this.events.publish(user.id, id));
    return { ok: true };
  }

  @Post(':id/blocked-seats')
  @HttpCode(200)
  @ApiOkResponse({ type: BlockedResultDto })
  async block(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: BlockSeatsDto): Promise<BlockedResultDto> {
    return unwrap(await this.events.block(user.id, id, body.seatIds, body.blocked));
  }
}
