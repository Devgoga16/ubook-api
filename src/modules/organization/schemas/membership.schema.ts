import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, Types, type HydratedDocument } from 'mongoose';
import { tenantPlugin } from '../../../core/database/tenant.plugin.js';

export type MembershipStatus = 'active' | 'invited' | 'suspended';

/** Usuario que forma parte del staff de una organización. */
@Schema({ timestamps: true, collection: 'memberships' })
export class Membership {
  organizationId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: [{ type: SchemaTypes.ObjectId, ref: 'Role' }], default: [] })
  roleIds: Types.ObjectId[];

  /** Sucursales donde opera. Vacío = todas. */
  @Prop({ type: [{ type: SchemaTypes.ObjectId, ref: 'Branch' }], default: [] })
  branchIds: Types.ObjectId[];

  @Prop({ type: String, enum: ['active', 'invited', 'suspended'], default: 'active' })
  status: MembershipStatus;

  /** Hasta cuándo leyó los avisos de la campana. */
  @Prop({ type: Date, default: null })
  notificationsReadAt: Date | null;
}

export type MembershipDocument = HydratedDocument<Membership>;
export const MembershipSchema = SchemaFactory.createForClass(Membership);
MembershipSchema.plugin(tenantPlugin);
MembershipSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
