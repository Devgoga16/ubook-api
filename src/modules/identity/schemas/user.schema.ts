import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import type { PlatformRole } from '../../../core/tenancy/tenant-context.js';

/**
 * Identidad global (quién eres). Lo que la persona es en cada negocio
 * (staff o cliente) vive en Membership / Client, dentro del tenant.
 */
@Schema({
  timestamps: true,
  collection: 'users',
  toJSON: {
    virtuals: true,
    versionKey: false,
    transform: (_doc, ret: Record<string, unknown>) => {
      delete ret._id;
      delete ret.passwordHash;
      return ret;
    },
  },
})
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ trim: true })
  phone?: string;

  @Prop({ required: true, trim: true })
  firstName: string;

  @Prop({ required: true, trim: true })
  lastName: string;

  @Prop({ select: false })
  passwordHash?: string;

  /** Solo para el equipo de Unify Tec. */
  @Prop({ type: String, enum: ['super_admin', 'support', null], default: null })
  platformRole: PlatformRole | null;

  @Prop({ default: true })
  isActive: boolean;

  @Prop()
  lastLoginAt?: Date;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);
