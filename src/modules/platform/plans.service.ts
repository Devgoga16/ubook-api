import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Errors } from '../../core/common/errors.js';
import { EntitlementsService } from './entitlements.service.js';
import { isFeatureKey, isValidFeatureValue, type FeatureValue } from './features.catalog.js';
import { DEFAULT_PLANS } from './plans.seed.js';
import { Plan, type PlanDocument } from './schemas/plan.schema.js';

export interface PlanInput {
  code?: string;
  name?: string;
  description?: string;
  price?: { monthly: number; yearly: number; currency: string };
  features?: Record<string, FeatureValue>;
  isPublic?: boolean;
  isActive?: boolean;
  sortOrder?: number;
}

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    @InjectModel(Plan.name) private readonly plans: Model<Plan>,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Planes visibles en la página de precios. */
  listPublic(): Promise<PlanDocument[]> {
    return this.plans.find({ isPublic: true, isActive: true }).sort({ sortOrder: 1 }).exec();
  }

  listAll(): Promise<PlanDocument[]> {
    return this.plans.find().sort({ sortOrder: 1 }).exec();
  }

  findByCode(code: string): Promise<PlanDocument | null> {
    return this.plans.findOne({ code: code.toLowerCase() }).exec();
  }

  async getByCode(code: string): Promise<PlanDocument> {
    const plan = await this.findByCode(code);
    if (!plan) throw Errors.notFound('Plan');
    return plan;
  }

  async create(input: PlanInput & { code: string; name: string }): Promise<PlanDocument> {
    this.assertValidFeatures(input.features);
    if (await this.findByCode(input.code)) {
      throw Errors.conflict('PLAN_CODE_TAKEN', 'Ya existe un plan con ese código');
    }
    return this.plans.create(input);
  }

  async update(code: string, input: PlanInput): Promise<PlanDocument> {
    this.assertValidFeatures(input.features);
    const plan = await this.getByCode(code);
    const { features, code: _ignored, ...rest } = input;
    plan.set(rest);
    if (features) {
      for (const [key, value] of Object.entries(features)) plan.features.set(key, value);
    }
    await plan.save();
    this.entitlements.invalidateAll();
    return plan;
  }

  /**
   * Inserta los planes por defecto que falten. No modifica los existentes, salvo
   * los que aún tienen los precios iniciales en dólares: esos pasan a soles.
   */
  async seedDefaults(): Promise<void> {
    for (const plan of DEFAULT_PLANS) {
      const result = await this.plans
        .updateOne({ code: plan.code }, { $setOnInsert: plan }, { upsert: true })
        .exec();
      if (result.upsertedCount) this.logger.log(`Plan "${plan.code}" creado`);
      const migrated = await this.plans.updateOne({ code: plan.code, 'price.currency': 'USD' }, { $set: { price: plan.price } }).exec();
      if (migrated.modifiedCount) this.logger.log(`Plan "${plan.code}" pasó a soles (S/ ${plan.price.monthly / 100} al mes)`);
    }
  }

  private assertValidFeatures(features?: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(features ?? {})) {
      if (!isFeatureKey(key) || !isValidFeatureValue(key, value)) {
        throw Errors.badRequest('INVALID_FEATURE', `Funcionalidad inválida: ${key}`, { key, value });
      }
    }
  }
}
