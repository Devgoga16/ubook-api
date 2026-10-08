import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument, Types } from 'mongoose';
import { tenantPlugin } from '../../../core/database/tenant.plugin.js';
import {
  PERMISSION_KEYS,
  SCOPES,
  type PermissionKey,
  type Scope,
} from '../../../core/authorization/permissions.catalog.js';

@Schema({ _id: false })
export class RolePermissionEntry {
  @Prop({ type: String, enum: PERMISSION_KEYS, required: true })
  key: PermissionKey;

  @Prop({ type: String, enum: SCOPES, required: true })
  scope: Scope;
}

@Schema({ timestamps: true, collection: 'roles' })
export class Role {
  organizationId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ trim: true })
  description?: string;

  /** Clave de la plantilla de origen ('owner', 'admin'...). `null` en roles creados por el negocio. */
  @Prop({ type: String, default: null })
  templateKey: string | null;

  /** Rol bloqueado (Dueño): no se edita ni se elimina. */
  @Prop({ default: false })
  isLocked: boolean;

  @Prop({ type: [RolePermissionEntry], default: [] })
  permissions: RolePermissionEntry[];
}

export type RoleDocument = HydratedDocument<Role>;
export const RoleSchema = SchemaFactory.createForClass(Role);
RoleSchema.plugin(tenantPlugin);
RoleSchema.index({ organizationId: 1, name: 1 }, { unique: true });
