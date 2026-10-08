import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes } from 'node:crypto';
import { Types, type Model } from 'mongoose';
import type { Env } from '../../config/env.js';
import { Errors } from '../../core/common/errors.js';
import type { AuthContextType } from '../../core/tenancy/tenant-context.js';
import { Session, type SessionDocument } from './schemas/session.schema.js';

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  ctx: AuthContextType;
  org?: string;
  mid?: string;
}

export interface SessionContext {
  ctx: AuthContextType;
  organizationId?: string;
  membershipId?: string;
}

export interface ClientInfo {
  userAgent?: string;
  ip?: string;
}

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class SessionsService {
  constructor(
    @InjectModel(Session.name) private readonly sessions: Model<Session>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Inicia una sesión nueva (login). */
  start(userId: string, context: SessionContext, client: ClientInfo): Promise<IssuedTokens> {
    return this.issue(userId, new Types.ObjectId(), context, client);
  }

  /**
   * Cambia un refresh token por uno nuevo. Si el token ya había sido rotado,
   * alguien lo está reutilizando: se revoca toda la familia.
   */
  async rotate(
    refreshToken: string,
    client: ClientInfo,
    nextContext?: SessionContext,
  ): Promise<{ userId: string; context: SessionContext; tokens: IssuedTokens }> {
    const current = await this.sessions.findOne({ tokenHash: hashToken(refreshToken) }).exec();
    if (!current || current.revokedAt || current.expiresAt < new Date()) {
      throw Errors.unauthorized('Sesión expirada');
    }
    if (current.rotatedAt) {
      await this.sessions
        .updateMany({ familyId: current.familyId, revokedAt: null }, { revokedAt: new Date() })
        .exec();
      throw Errors.unauthorized('Sesión inválida');
    }

    const rotated = await this.sessions
      .updateOne({ _id: current._id, rotatedAt: null }, { rotatedAt: new Date() })
      .exec();
    if (rotated.modifiedCount === 0) throw Errors.unauthorized('Sesión inválida');

    const context = nextContext ?? this.contextOf(current);
    const tokens = await this.issue(current.userId.toString(), current.familyId, context, client);
    return { userId: current.userId.toString(), context, tokens };
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.sessions
      .updateOne({ tokenHash: hashToken(refreshToken), revokedAt: null }, { revokedAt: new Date() })
      .exec();
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.sessions.updateMany({ userId, revokedAt: null }, { revokedAt: new Date() }).exec();
  }

  private contextOf(session: SessionDocument): SessionContext {
    return {
      ctx: session.ctx,
      organizationId: session.organizationId?.toString(),
      membershipId: session.membershipId?.toString(),
    };
  }

  private async issue(
    userId: string,
    familyId: Types.ObjectId,
    context: SessionContext,
    client: ClientInfo,
  ): Promise<IssuedTokens> {
    const refreshToken = randomBytes(48).toString('base64url');
    const ttlDays = this.config.get('REFRESH_TTL_DAYS', { infer: true });
    const refreshTokenExpiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

    const session = await this.sessions.create({
      userId,
      familyId,
      tokenHash: hashToken(refreshToken),
      ctx: context.ctx,
      organizationId: context.organizationId,
      membershipId: context.membershipId,
      expiresAt: refreshTokenExpiresAt,
      userAgent: client.userAgent?.slice(0, 300),
      ip: client.ip,
    });

    const payload: AccessTokenPayload = {
      sub: userId,
      sid: session.id as string,
      ctx: context.ctx,
      ...(context.organizationId && { org: context.organizationId }),
      ...(context.membershipId && { mid: context.membershipId }),
    };
    const accessTokenExpiresIn = this.config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: accessTokenExpiresIn });

    return { accessToken, accessTokenExpiresIn, refreshToken, refreshTokenExpiresAt };
  }
}
