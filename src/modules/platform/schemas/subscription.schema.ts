import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, Types, type HydratedDocument } from 'mongoose';
import type { FeatureValue } from '../features.catalog.js';

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'cancelled', 'expired'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export type BillingCycle = 'monthly' | 'yearly';

/**
 * Suscripción de una organización. Sin pasarela de pagos por ahora:
 * el super admin la activa y renueva manualmente.
 */
@Schema({ timestamps: true, collection: 'subscriptions' })
export class Subscription {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Organization', required: true, unique: true })
  organizationId: Types.ObjectId;

  @Prop({ required: true })
  planCode: string;

  @Prop({ type: String, enum: SUBSCRIPTION_STATUSES, required: true })
  status: SubscriptionStatus;

  @Prop({ type: String, enum: ['monthly', 'yearly'], default: 'monthly' })
  billingCycle: BillingCycle;

  @Prop()
  trialEndsAt?: Date;

  @Prop()
  currentPeriodEnd?: Date;

  @Prop()
  cancelledAt?: Date;

  /** Excepciones puntuales que da el super admin (p. ej. +2 profesionales). */
  @Prop({ type: Map, of: Object, default: {} })
  overrides: Map<string, FeatureValue>;
}

export type SubscriptionDocument = HydratedDocument<Subscription>;
export const SubscriptionSchema = SchemaFactory.createForClass(Subscription);
