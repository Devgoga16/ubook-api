import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument, Types } from 'mongoose';
import { tenantPlugin } from '../../../core/database/tenant.plugin.js';

/**
 * Código de un solo uso para entrar al portal del cliente de un negocio.
 * Solo se guarda su hash. Se registra también para celulares que no son
 * clientes (sin enviarlo), para que el límite de pedidos no revele quién lo es.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'portal_codes' })
export class PortalCode {
  organizationId: Types.ObjectId;

  /** Celular en formato E.164 (+51987654321). */
  @Prop({ required: true })
  phone: string;

  @Prop({ required: true })
  codeHash: string;

  @Prop({ required: true })
  expiresAt: Date;

  /** Intentos fallidos con este código. */
  @Prop({ default: 0 })
  attempts: number;

  @Prop({ type: Date, default: null })
  usedAt: Date | null;

  createdAt: Date;
}

export type PortalCodeDocument = HydratedDocument<PortalCode>;
export const PortalCodeSchema = SchemaFactory.createForClass(PortalCode);
PortalCodeSchema.plugin(tenantPlugin);
PortalCodeSchema.index({ organizationId: 1, phone: 1, createdAt: -1 });
// Mongo los borra una hora después de vencer.
PortalCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 });
