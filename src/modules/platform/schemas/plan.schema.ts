import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import type { FeatureValue } from '../features.catalog.js';

@Schema({ _id: false })
export class PlanPrice {
  /** Precio mensual en la unidad mínima de la moneda (centavos). */
  @Prop({ required: true, min: 0 })
  monthly: number;

  /** Precio del año completo (ya con descuento) en centavos. */
  @Prop({ required: true, min: 0 })
  yearly: number;

  @Prop({ required: true, uppercase: true, minlength: 3, maxlength: 3 })
  currency: string;
}

@Schema({ timestamps: true, collection: 'plans' })
export class Plan {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  code: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ trim: true })
  description?: string;

  @Prop({ type: PlanPrice, required: true })
  price: PlanPrice;

  @Prop({ type: Map, of: Object, default: {} })
  features: Map<string, FeatureValue>;

  /** Visible en la página de precios. */
  @Prop({ default: true })
  isPublic: boolean;

  /** Se puede contratar. Un plan inactivo sigue vigente para quien ya lo tiene. */
  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: 0 })
  sortOrder: number;
}

export type PlanDocument = HydratedDocument<Plan>;
export const PlanSchema = SchemaFactory.createForClass(Plan);
