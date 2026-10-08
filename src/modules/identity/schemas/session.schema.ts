import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, Types, type HydratedDocument } from 'mongoose';
import type { AuthContextType } from '../../../core/tenancy/tenant-context.js';

/**
 * Sesión con refresh token rotativo. Solo se guarda el hash del token.
 * Si se reutiliza un token ya rotado, se revoca toda la familia (posible robo).
 */
@Schema({ timestamps: true, collection: 'sessions' })
export class Session {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ required: true, unique: true })
  tokenHash: string;

  /** Agrupa las sesiones derivadas por rotación del mismo login. */
  @Prop({ type: SchemaTypes.ObjectId, required: true, index: true })
  familyId: Types.ObjectId;

  @Prop({ type: String, enum: ['account', 'staff', 'platform'], required: true })
  ctx: AuthContextType;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Organization' })
  organizationId?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Membership' })
  membershipId?: Types.ObjectId;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop()
  revokedAt?: Date;

  @Prop()
  rotatedAt?: Date;

  @Prop()
  userAgent?: string;

  @Prop()
  ip?: string;
}

export type SessionDocument = HydratedDocument<Session>;
export const SessionSchema = SchemaFactory.createForClass(Session);
// Mongo elimina las sesiones vencidas automáticamente.
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
