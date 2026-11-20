import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ApiErrors } from '../../common/api-errors.decorator.js';
import { AppException } from '../../common/app.exception.js';
import { CurrentUser, Roles, type AuthUser } from '../../common/decorators.js';
import { appError } from '../../common/result.js';
import { VenueDto, VenueGeometryDto, VenueLayoutDto, VenueListDto } from './dto/venue.dto.js';
import { VenuesService } from './venues.service.js';

const notFound = (): AppException => new AppException(appError('NOT_FOUND', 'Venue not found'));

@ApiTags('venues')
@ApiBearerAuth()
@ApiErrors()
@Roles('organizer')
@Controller('venues')
export class VenuesController {
  constructor(private readonly venues: VenuesService) {}

  @Post()
  @ApiOkResponse({ type: VenueDto })
  create(@CurrentUser() user: AuthUser, @Body() body: VenueLayoutDto): Promise<VenueDto> {
    return this.venues.create(user.id, body);
  }

  @Get()
  @ApiOkResponse({ type: VenueListDto })
  async list(@CurrentUser() user: AuthUser): Promise<VenueListDto> {
    return { items: [...(await this.venues.list(user.id))] };
  }

  @Get(':id')
  @ApiOkResponse({ type: VenueDto })
  async get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<VenueDto> {
    return (await this.venues.get(user.id, id)) ?? Promise.reject(notFound());
  }

  @Get(':id/geometry')
  @ApiOkResponse({ type: VenueGeometryDto })
  async geometry(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<VenueGeometryDto> {
    return (await this.venues.geometry(user.id, id)) ?? Promise.reject(notFound());
  }
}
