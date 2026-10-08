import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, Types, type HydratedDocument } from 'mongoose';

/** Enlace para crear una contraseña nueva. Solo se guarda el hash del token; vale una vez. */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'password_resets' })
export class PasswordReset {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ required: true, unique: true })
  tokenHash: string;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ type: Date, default: null })
  usedAt: Date | null;
}

export type PasswordResetDocument = HydratedDocument<PasswordReset>;
export const PasswordResetSchema = SchemaFactory.createForClass(PasswordReset);
// Mongo borra los enlaces un día después de vencer.
PasswordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });
