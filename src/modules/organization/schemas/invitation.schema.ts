import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, type HydratedDocument, type Types } from 'mongoose';
import { tenantPlugin } from '../../../core/database/tenant.plugin.js';

export type InvitationStatus = 'pending' | 'accepted' | 'revoked';

/** Invitación por correo para unirse al equipo de un negocio. */
@Schema({
  timestamps: true,
  collection: 'invitations',
  toJSON: {
    virtuals: true,
    versionKey: false,
    transform: (_doc, ret: Record<string, unknown>) => {
      delete ret._id;
      delete ret.tokenHash;
      return ret;
    },
  },
})
export class Invitation {
  organizationId: Types.ObjectId;

  @Prop({ required: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true, trim: true })
  firstName: string;

  @Prop({ trim: true, default: '' })
  lastName: string;

  @Prop({ type: [{ type: SchemaTypes.ObjectId, ref: 'Role' }], default: [] })
  roleIds: Types.ObjectId[];

  /** Vacío = todas las sucursales. */
  @Prop({ type: [{ type: SchemaTypes.ObjectId, ref: 'Branch' }], default: [] })
  branchIds: Types.ObjectId[];

  /** Al aceptar, se vincula a este perfil de profesional. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Professional', default: null })
  professionalId: Types.ObjectId | null;

  /** SHA-256 del token del enlace; el token en claro solo viaja en el correo. */
  @Prop({ required: true, index: true })
  tokenHash: string;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ type: String, enum: ['pending', 'accepted', 'revoked'], default: 'pending' })
  status: InvitationStatus;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  invitedByUserId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  acceptedByUserId: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  acceptedAt: Date | null;
}

export type InvitationDocument = HydratedDocument<Invitation>;
export const InvitationSchema = SchemaFactory.createForClass(Invitation);
InvitationSchema.plugin(tenantPlugin);
InvitationSchema.index({ organizationId: 1, email: 1, status: 1 });
