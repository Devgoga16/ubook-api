import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, type HydratedDocument, type Types } from 'mongoose';
import type { BillingCycle } from './subscription.schema.js';

export const BILLING_METHODS = ['yape', 'plin', 'transfer', 'deposit', 'card', 'other'] as const;
export type BillingMethod = (typeof BILLING_METHODS)[number];

/**
 * Pago de la suscripción que reporta un negocio (sin pasarela). Colección de
 * plataforma: la revisa y aprueba el equipo de Unify Tec.
 */
@Schema({ timestamps: true, collection: 'subscription_payments' })
export class SubscriptionPayment {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Organization', required: true, index: true })
  organizationId: Types.ObjectId;

  @Prop({ required: true })
  planCode: string;

  @Prop({ type: String, enum: ['monthly', 'yearly'], required: true })
  billingCycle: BillingCycle;

  /** Céntimos de la moneda indicada. */
  @Prop({ required: true, min: 1 })
  amount: number;

  @Prop({ type: String, enum: ['PEN', 'USD'], default: 'PEN' })
  currency: 'PEN' | 'USD';

  @Prop({ type: String, enum: BILLING_METHODS, required: true })
  method: BillingMethod;

  /** N.º de operación del Yape/transferencia. */
  @Prop({ required: true, trim: true })
  reference: string;

  @Prop({ required: true, match: /^\d{4}-\d{2}-\d{2}$/ })
  paidOn: string;

  /** Foto del comprobante (almacenamiento privado). */
  @Prop({ type: String, default: null })
  proofKey: string | null;

  @Prop({ trim: true })
  note?: string;

  @Prop({ type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true })
  status: 'pending' | 'approved' | 'rejected';

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  reportedBy: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  reviewedBy: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  reviewedAt: Date | null;

  @Prop({ trim: true })
  rejectReason?: string;

  /** Periodo que activó al aprobarse. */
  @Prop({ type: Date, default: null })
  periodStart: Date | null;

  @Prop({ type: Date, default: null })
  periodEnd: Date | null;
}

export type SubscriptionPaymentDocument = HydratedDocument<SubscriptionPayment>;
export const SubscriptionPaymentSchema = SchemaFactory.createForClass(SubscriptionPayment);
