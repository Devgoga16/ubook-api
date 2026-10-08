import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, Types, type HydratedDocument } from 'mongoose';
import { tenantPlugin } from '../../../core/database/tenant.plugin.js';

export type DepositType = 'percent' | 'fixed';

@Schema({ _id: false })
export class DepositRule {
  @Prop({ default: false })
  enabled: boolean;

  @Prop({ type: String, enum: ['percent', 'fixed'], default: 'percent' })
  type: DepositType;

  /** Porcentaje (1–100) o monto fijo en céntimos. */
  @Prop({ default: 0, min: 0 })
  value: number;
}

/**
 * Lo que el negocio ofrece y se puede reservar. Genérico: sirve igual para
 * un corte, una sesión de terapia o una limpieza dental.
 */
@Schema({ timestamps: true, collection: 'services' })
export class Service {
  organizationId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ trim: true })
  description?: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'ServiceCategory', default: null, index: true })
  categoryId: Types.ObjectId | null;

  /** Duración de la atención en minutos. */
  @Prop({ required: true, min: 5, max: 720 })
  durationMinutes: number;

  /** Precio en céntimos de la moneda del negocio (S/ 50.00 → 5000). */
  @Prop({ required: true, min: 0 })
  price: number;

  /** Tiempo bloqueado antes de la cita (preparación). */
  @Prop({ default: 0, min: 0, max: 240 })
  bufferBeforeMinutes: number;

  /** Tiempo bloqueado después de la cita (limpieza). */
  @Prop({ default: 0, min: 0, max: 240 })
  bufferAfterMinutes: number;

  @Prop({ type: DepositRule, default: () => ({}) })
  deposit: DepositRule;

  /** Visible y reservable en la página pública. */
  @Prop({ default: true })
  onlineBooking: boolean;

  /** Color en la agenda. */
  @Prop({ default: '#243352', match: /^#[0-9a-fA-F]{6}$/ })
  color: string;

  /** Archivado: no se ofrece, pero se conserva para el historial de citas. */
  @Prop({ default: false, index: true })
  isArchived: boolean;

  @Prop({ default: 0 })
  sortOrder: number;
}

export type ServiceDocument = HydratedDocument<Service>;
export const ServiceSchema = SchemaFactory.createForClass(Service);
ServiceSchema.plugin(tenantPlugin);
