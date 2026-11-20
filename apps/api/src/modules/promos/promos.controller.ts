import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ApiErrors } from '../../common/api-errors.decorator.js';
import { unwrap } from '../../common/app.exception.js';
import { CurrentUser, Roles, type AuthUser } from '../../common/decorators.js';
import { CreatePromoDto, PromoDto, PromoListDto } from './dto/promo.dto.js';
import { PromosService } from './promos.service.js';

@ApiTags('promos')
@ApiBearerAuth()
@ApiErrors()
@Roles('organizer')
@Controller('promos')
export class PromosController {
  constructor(private readonly promos: PromosService) {}

  @Post()
  @ApiOkResponse({ type: PromoDto })
  async create(@CurrentUser() user: AuthUser, @Body() body: CreatePromoDto): Promise<PromoDto> {
    return unwrap(await this.promos.create(user.id, body));
  }

  @Get()
  @ApiOkResponse({ type: PromoListDto })
  async list(@CurrentUser() user: AuthUser): Promise<PromoListDto> {
    return { items: [...(await this.promos.list(user.id))] };
  }
}
