import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Errors } from '../../core/common/errors.js';
import { Organization } from '../organization/schemas/organization.schema.js';
import {
  defaultFeatureValue,
  FEATURE_KEYS,
  type FeatureKey,
  type FeatureSet,
} from './features.catalog.js';
import { Plan } from './schemas/plan.schema.js';
import { Subscription, type SubscriptionStatus } from './schemas/subscription.schema.js';

export interface Entitlements {
  organizationId: string;
  planCode: string;
  planName: string;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  /** Suscripción vencida o negocio suspendido: solo lectura. */
  readOnly: boolean;
  suspended: boolean;
  features: FeatureSet;
}

const CACHE_TTL_MS = 60_000;

/**
 * Qué puede usar cada negocio: plan + excepciones + estado de la suscripción.
 * Se cachea en memoria 60 s; los cambios de plan invalidan la caché.
 */
@Injectable()
export class EntitlementsService {
  private readonly cache = new Map<string, { value: Entitlements; expiresAt: number }>();

  constructor(
    @InjectModel(Subscription.name) private readonly subscriptions: Model<Subscription>,
    @InjectModel(Plan.name) private readonly plans: Model<Plan>,
    @InjectModel(Organization.name) private readonly organizations: Model<Organization>,
  ) {}

  async get(organizationId: string): Promise<Entitlements> {
    const cached = this.cache.get(organizationId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const value = await this.load(organizationId);
    this.cache.set(organizationId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }

  invalidate(organizationId: string): void {
    this.cache.delete(organizationId);
  }

  /** Al editar un plan cambia lo que incluyen todos los negocios que lo tienen. */
  invalidateAll(): void {
    this.cache.clear();
  }

  async hasFeature(organizationId: string, feature: FeatureKey): Promise<boolean> {
    const value = (await this.get(organizationId)).features[feature];
    return value === null || value === true || (typeof value === 'number' && value > 0);
  }

  async assertFeature(organizationId: string, feature: FeatureKey): Promise<void> {
    if (!(await this.hasFeature(organizationId, feature))) throw Errors.featureNotInPlan(feature);
  }

  /**
   * Lanza error si crear uno más superaría el límite del plan.
   * @param currentCount cantidad actual (la calcula el módulo dueño del recurso).
   */
  async assertWithinLimit(
    organizationId: string,
    feature: FeatureKey,
    currentCount: number,
  ): Promise<void> {
    const limit = (await this.get(organizationId)).features[feature];
    if (limit === null) return;
    const max = typeof limit === 'number' ? limit : 0;
    if (currentCount >= max) throw Errors.planLimitReached(feature, max);
  }

  private async load(organizationId: string): Promise<Entitlements> {
    const [subscription, organization] = await Promise.all([
      this.subscriptions.findOne({ organizationId }).exec(),
      this.organizations.findById(organizationId).select('status').exec(),
    ]);
    if (!subscription || !organization) throw Errors.notFound('Suscripción');

    const plan = await this.plans.findOne({ code: subscription.planCode }).exec();
    const features = {} as FeatureSet;
    for (const key of FEATURE_KEYS) {
      const override = subscription.overrides.get(key);
      // `null` en el plan significa ilimitado: no confundirlo con "no definido".
      const fromPlan = plan?.features.has(key) ? plan.features.get(key) : undefined;
      features[key] = override !== undefined ? override : fromPlan !== undefined ? fromPlan : defaultFeatureValue(key);
    }

    const status = effectiveStatus(subscription);
    const suspended = organization.status === 'suspended';
    return {
      organizationId,
      planCode: subscription.planCode,
      planName: plan?.name ?? subscription.planCode,
      status,
      trialEndsAt: subscription.trialEndsAt ?? null,
      currentPeriodEnd: subscription.currentPeriodEnd ?? null,
      readOnly: suspended || status === 'expired' || status === 'cancelled',
      suspended,
      features,
    };
  }
}

/** El estado guardado puede quedar desactualizado: la fecha manda. */
export function effectiveStatus(
  sub: Pick<Subscription, 'status' | 'trialEndsAt' | 'currentPeriodEnd'>,
  now = new Date(),
): SubscriptionStatus {
  if (sub.status === 'trialing' && sub.trialEndsAt && sub.trialEndsAt <= now) return 'expired';
  if (sub.status === 'active' && sub.currentPeriodEnd && sub.currentPeriodEnd <= now) return 'expired';
  return sub.status;
}
