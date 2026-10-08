import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import type { Env } from '../../config/env.js';
import { Errors } from '../../core/common/errors.js';
import { EntitlementsService } from './entitlements.service.js';
import { isFeatureKey, isValidFeatureValue, type FeatureValue } from './features.catalog.js';
import { PlansService } from './plans.service.js';
import {
  Subscription,
  type BillingCycle,
  type SubscriptionDocument,
  type SubscriptionStatus,
} from './schemas/subscription.schema.js';

export interface UpdateSubscriptionInput {
  planCode?: string;
  status?: SubscriptionStatus;
  billingCycle?: BillingCycle;
  trialEndsAt?: Date;
  currentPeriodEnd?: Date;
  /** `null` elimina la excepción y vuelve al valor del plan. */
  overrides?: Record<string, FeatureValue | null>;
}

@Injectable()
export class SubscriptionsService {
  constructor(
    @InjectModel(Subscription.name) private readonly subscriptions: Model<Subscription>,
    private readonly plans: PlansService,
    private readonly entitlements: EntitlementsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Prueba gratis de TRIAL_DAYS días. Durante la prueba el negocio tiene
   * el plan que eligió (por defecto TRIAL_PLAN_CODE).
   */
  async startTrial(
    organizationId: string,
    planCode: string | undefined,
    session?: ClientSession,
  ): Promise<SubscriptionDocument> {
    const code = planCode ?? this.config.get('TRIAL_PLAN_CODE', { infer: true });
    const plan = await this.plans.getByCode(code);
    if (!plan.isActive) throw Errors.badRequest('PLAN_UNAVAILABLE', 'Ese plan no está disponible');

    const days = this.config.get('TRIAL_DAYS', { infer: true });
    const [subscription] = await this.subscriptions.create(
      [
        {
          organizationId,
          planCode: plan.code,
          status: 'trialing',
          trialEndsAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
        },
      ],
      { session },
    );
    return subscription;
  }

  findByOrganization(organizationId: string): Promise<SubscriptionDocument | null> {
    return this.subscriptions.findOne({ organizationId }).exec();
  }

  findByOrganizations(organizationIds: string[]): Promise<SubscriptionDocument[]> {
    return this.subscriptions.find({ organizationId: { $in: organizationIds } }).exec();
  }

  /** Cambio manual por el super admin (no hay pasarela de pagos). */
  async update(organizationId: string, input: UpdateSubscriptionInput): Promise<SubscriptionDocument> {
    const subscription = await this.findByOrganization(organizationId);
    if (!subscription) throw Errors.notFound('Suscripción');

    if (input.planCode) subscription.planCode = (await this.plans.getByCode(input.planCode)).code;
    if (input.billingCycle) subscription.billingCycle = input.billingCycle;
    if (input.trialEndsAt) subscription.trialEndsAt = input.trialEndsAt;
    if (input.currentPeriodEnd) subscription.currentPeriodEnd = input.currentPeriodEnd;
    if (input.status) {
      subscription.status = input.status;
      if (input.status === 'cancelled') subscription.cancelledAt = new Date();
    }
    for (const [key, value] of Object.entries(input.overrides ?? {})) {
      if (!isFeatureKey(key)) throw Errors.badRequest('INVALID_FEATURE', `Funcionalidad inválida: ${key}`);
      if (value === null) {
        subscription.overrides.delete(key);
      } else if (isValidFeatureValue(key, value)) {
        subscription.overrides.set(key, value);
      } else {
        throw Errors.badRequest('INVALID_FEATURE', `Valor inválido para ${key}`);
      }
    }

    await subscription.save();
    this.entitlements.invalidate(organizationId);
    return subscription;
  }
}
