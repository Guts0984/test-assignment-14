import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiErrors } from '../../common/api-errors.decorator.js';
import { AppException, unwrap } from '../../common/app.exception.js';
import { CurrentUser, Public, type AuthUser } from '../../common/decorators.js';
import { appError } from '../../common/result.js';
import { CLIENT_IP } from '../../infra/tokens.js';
import { AuthService } from './auth.service.js';
import { LoginDto, MeDto, RefreshDto, RegisterDto, TokenPairDto } from './dto/auth.dto.js';
import type { TokenPair } from './domain/auth-flow.js';

const REFRESH_COOKIE = 'rt';

const readCookie = (req: Request, name: string): string | undefined =>
  req.headers.cookie?.split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];

const withCookie = (res: Response, pair: TokenPair): TokenPair => {
  res.cookie(REFRESH_COOKIE, pair.refreshToken, { httpOnly: true, sameSite: 'strict', path: '/api/auth', maxAge: 30 * 24 * 3600 * 1000 });
  return pair;
};

@ApiTags('auth')
@ApiErrors()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(CLIENT_IP) private readonly clientIp: (req: Request) => string,
  ) {}

  @Public()
  @Post('register')
  @ApiOkResponse({ type: TokenPairDto })
  async register(@Body() body: RegisterDto, @Res({ passthrough: true }) res: Response): Promise<TokenPair> {
    return withCookie(res, unwrap(await this.auth.register(body)));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOkResponse({ type: TokenPairDto })
  async login(@Body() body: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<TokenPair> {
    return withCookie(res, unwrap(await this.auth.login(this.clientIp(req), body.email, body.password)));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOkResponse({ type: TokenPairDto })
  async refresh(@Body() body: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<TokenPair> {
    const token = body.refreshToken ?? readCookie(req, REFRESH_COOKIE);
    if (!token) throw new AppException(appError('UNAUTHENTICATED', 'Refresh token is required'));
    return withCookie(res, unwrap(await this.auth.refresh(token)));
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = body.refreshToken ?? readCookie(req, REFRESH_COOKIE);
    if (token) await this.auth.logout(token);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOkResponse({ type: MeDto })
  async me(@CurrentUser() user: AuthUser): Promise<MeDto> {
    const found = await this.auth.me(user.id);
    if (!found) throw new AppException(appError('UNAUTHENTICATED', 'Account no longer exists'));
    return found;
  }
}
