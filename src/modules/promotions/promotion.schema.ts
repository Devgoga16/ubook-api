import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, type HydratedDocument, type Types } from 'mongoose';
import { tenantPlugin } from '../../core/database/tenant.plugin.js';

/** Cupón de descuento para reservas. */
@Schema({ timestamps: true, collection: 'promotions' })
export class Promotion {
  organizationId: Types.ObjectId;

  /** En mayúsculas, sin espacios (OCTUBRE15). */
  @Prop({ required: true, uppercase: true, trim: true })
  code: string;

  @Prop({ trim: true, default: '' })
  description: string;

  @Prop({ type: String, enum: ['percent', 'amount'], required: true })
  type: 'percent' | 'amount';

  /** Porcentaje (1–100) o monto en céntimos. */
  @Prop({ required: true, min: 1 })
  value: number;

  /** Vacío = todos los servicios. */
  @Prop({ type: [{ type: SchemaTypes.ObjectId, ref: 'Service' }], default: [] })
  serviceIds: Types.ObjectId[];

  /** Fechas de la cita en que vale ("YYYY-MM-DD"). */
  @Prop({ type: String, default: null })
  validFrom: string | null;

  @Prop({ type: String, default: null })
  validTo: string | null;

  /** Días ISO (1 = lunes). Vacío = todos. */
  @Prop({ type: [Number], default: [] })
  weekdays: number[];

  /** Franja horaria de la cita en minutos locales. `null` = todo el día. */
  @Prop({ type: Number, default: null })
  fromMinute: number | null;

  @Prop({ type: Number, default: null })
  toMinute: number | null;

  /** Solo para clientes sin visitas completadas. */
  @Prop({ default: false })
  newClientsOnly: boolean;

  /** Un uso por cliente. */
  @Prop({ default: true })
  oncePerClient: boolean;

  /** Usos totales permitidos. `null` = sin límite. */
  @Prop({ type: Number, default: null })
  maxUses: number | null;

  @Prop({ default: true })
  isActive: boolean;
}

export type PromotionDocument = HydratedDocument<Promotion>;
export const PromotionSchema = SchemaFactory.createForClass(Promotion);
PromotionSchema.plugin(tenantPlugin);
PromotionSchema.index({ organizationId: 1, code: 1 }, { unique: true });
