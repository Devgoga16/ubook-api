import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { Env } from '../../config/env.js';
import {
  AllowContexts,
  AllowWhenReadOnly,
  CurrentActor,
  Public,
} from '../../core/auth/decorators.js';
import { Errors } from '../../core/common/errors.js';
import type { Actor } from '../../core/tenancy/tenant-context.js';
import type { ClientInfo } from '../identity/sessions.service.js';
import { AcceptInvitationDto } from '../organization/dto/invitation.dto.js';
import { CreateOrganizationDto } from '../organization/dto/organization.dto.js';
import { InvitationsService } from '../organization/invitations.service.js';
import { AuthService, type AuthResult } from './auth.service.js';
import { ForgotPasswordDto, LoginDto, RegisterDto, ResetPasswordDto, SwitchOrganizationDto } from './dto/auth.dto.js';
import { PasswordResetService } from '../identity/password-reset.service.js';

export const REFRESH_COOKIE = 'ubook_rt';
export const REFRESH_COOKIE_PATH = '/api/auth';

const STRICT_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly invitations: InvitationsService,
    private readonly passwordReset: PasswordResetService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Public()
  @Throttle(STRICT_THROTTLE)
  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.register(dto, clientInfo(req)));
  }

  @Public()
  @Throttle(STRICT_THROTTLE)
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.login(dto, clientInfo(req)));
  }

  /** Datos de la invitación para la página pública (negocio, rol, si ya tiene cuenta). */
  @Public()
  @Throttle(STRICT_THROTTLE)
  @Get('invitations/:token')
  invitation(@Param('token') token: string) {
    return this.invitations.preview(token);
  }

  @Public()
  @Throttle(STRICT_THROTTLE)
  @Post('accept-invitation')
  @HttpCode(200)
  async acceptInvitation(@Body() dto: AcceptInvitationDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.acceptInvitation(dto, clientInfo(req)));
  }

  /** Envía el enlace para crear una contraseña nueva. Responde igual exista o no la cuenta. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 15 * 60_000 } })
  @Post('forgot-password')
  @HttpCode(204)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.passwordReset.request(dto.email);
  }

  @Public()
  @Throttle(STRICT_THROTTLE)
  @Get('password-reset/:token')
  passwordResetPreview(@Param('token') token: string) {
    return this.passwordReset.preview(token);
  }

  @Public()
  @Throttle(STRICT_THROTTLE)
  @Post('reset-password')
  @HttpCode(204)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.passwordReset.reset(dto.token, dto.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      return this.respond(res, await this.auth.refresh(refreshTokenOf(req), clientInfo(req)));
    } catch (error) {
      this.clearCookie(res);
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (token) await this.auth.logout(token);
    this.clearCookie(res);
  }

  @AllowContexts('account', 'staff', 'platform')
  @AllowWhenReadOnly()
  @Get('me')
  me(@CurrentActor() actor: Actor) {
    return this.auth.me(actor);
  }

  @AllowContexts('account', 'staff')
  @AllowWhenReadOnly()
  @Post('switch-organization')
  @HttpCode(200)
  async switchOrganization(
    @CurrentActor() actor: Actor,
    @Body() dto: SwitchOrganizationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.switchOrganization(
      actor,
      dto.organizationId,
      refreshTokenOf(req),
      clientInfo(req),
    );
    return this.respond(res, result);
  }

  /** Un usuario existente crea otro negocio (con su propia prueba gratis). */
  @AllowContexts('account', 'staff')
  @AllowWhenReadOnly()
  @Throttle(STRICT_THROTTLE)
  @Post('organizations')
  async createOrganization(
    @CurrentActor() actor: Actor,
    @Body() dto: CreateOrganizationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.createOrganization(actor, dto, refreshTokenOf(req), clientInfo(req));
    return this.respond(res, result);
  }

  private respond(res: Response, { tokens, context }: AuthResult) {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, { ...this.cookieOptions(), expires: tokens.refreshTokenExpiresAt });
    return {
      accessToken: tokens.accessToken,
      expiresIn: tokens.accessTokenExpiresIn,
      context,
    };
  }

  private clearCookie(res: Response) {
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  /** SameSite=None solo funciona con Secure (HTTPS). */
  private cookieOptions() {
    const sameSite = this.config.get('COOKIE_SAMESITE', { infer: true });
    const secure = sameSite === 'none' || this.config.get('NODE_ENV', { infer: true }) === 'production';
    return { httpOnly: true, secure, sameSite, path: REFRESH_COOKIE_PATH } as const;
  }
}

function refreshTokenOf(req: Request): string {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!token) throw Errors.unauthorized('Sesión expirada');
  return token;
}

function clientInfo(req: Request): ClientInfo {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}
