import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { Env } from '../../config/env.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { Errors } from '../../core/common/errors.js';
import { StorageService } from '../../core/storage/storage.service.js';
import { Organization } from '../organization/schemas/organization.schema.js';
import { effectiveStatus, EntitlementsService } from './entitlements.service.js';
import { PlansService } from './plans.service.js';
import { SubscriptionPayment, type BillingMethod, type SubscriptionPaymentDocument } from './schemas/subscription-payment.schema.js';
import { Subscription, type BillingCycle } from './schemas/subscription.schema.js';

export interface ReportPaymentInput {
  planCode: string;
  billingCycle: BillingCycle;
  amount: number;
  currency: 'PEN' | 'USD';
  method: BillingMethod;
  reference: string;
  paidOn: string;
  note?: string;
  proofKey: string;
}

/** Suma un mes o un año a una fecha (fin de mes → fin del mes siguiente). */
export function addPeriod(from: Date, cycle: BillingCycle): Date {
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + (cycle === 'yearly' ? 12 : 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** Cobro manual de la suscripción de uBook: el negocio reporta, la plataforma aprueba. */
@Injectable()
export class BillingService {
  constructor(
    @InjectModel(SubscriptionPayment.name) private readonly payments: Model<SubscriptionPayment>,
    @InjectModel(Subscription.name) private readonly subscriptions: Model<Subscription>,
    @InjectModel(Organization.name) private readonly organizations: Model<Organization>,
    private readonly plans: PlansService,
    private readonly entitlements: EntitlementsService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  /* ---------- Lado del negocio ---------- */

  async overview(organizationId: string) {
    const sub = await this.subscriptions.findOne({ organizationId }).exec();
    if (!sub) throw Errors.notFound('Suscripción');
    const [plans, history] = await Promise.all([
      this.plans.listPublic(),
      this.payments.find({ organizationId }).sort({ createdAt: -1 }).limit(24).exec(),
    ]);
    return {
      subscription: {
        planCode: sub.planCode,
        status: effectiveStatus(sub),
        billingCycle: sub.billingCycle ?? 'monthly',
        trialEndsAt: sub.trialEndsAt ?? null,
        currentPeriodEnd: sub.currentPeriodEnd ?? null,
      },
      plans: plans.map((p) => ({ code: p.code, name: p.name, description: p.description ?? '', price: p.price })),
      payments: history.map((p) => this.view(p)),
      instructions: {
        yape: this.config.get('BILLING_YAPE', { infer: true }) ?? null,
        bank: this.config.get('BILLING_BANK', { infer: true }) ?? null,
        contact: this.config.get('BILLING_CONTACT', { infer: true }) ?? null,
      },
    };
  }

  async report(organizationId: string, userId: string, input: ReportPaymentInput) {
    const plan = await this.plans.getByCode(input.planCode);
    if (!plan.isActive || !plan.isPublic) throw Errors.badRequest('PLAN_UNAVAILABLE', 'Ese plan no está disponible');
    if (!input.proofKey?.startsWith(`billing/${organizationId}/`)) {
      throw Errors.badRequest('PROOF_REQUIRED', 'Sube la foto del comprobante del pago');
    }
    if (await this.payments.exists({ organizationId, status: 'pending' })) {
      throw Errors.conflict('PAYMENT_PENDING', 'Ya tienes un pago en revisión. Te avisaremos apenas lo confirmemos.');
    }
    const payment = await this.payments.create({ ...input, organizationId, reportedBy: userId });
    await this.audit.log({ action: 'billing.payment_reported', organizationId, entityType: 'SubscriptionPayment', entityId: payment.id as string, metadata: { ...input } });
    return this.view(payment);
  }

  /* ---------- Lado de la plataforma ---------- */

  async listForPlatform(status: 'pending' | 'approved' | 'rejected' = 'pending') {
    const docs = await this.payments.find({ status }).sort({ createdAt: status === 'pending' ? 1 : -1 }).limit(200).exec();
    const orgs = await this.organizations.find({ _id: { $in: docs.map((d) => d.organizationId) } }).select('name slug').exec();
    return docs.map((d) => ({ ...this.view(d), organization: orgs.find((o) => o._id.equals(d.organizationId)) ?? null }));
  }

  async listForOrganization(organizationId: string) {
    const docs = await this.payments.find({ organizationId }).sort({ createdAt: -1 }).limit(50).exec();
    return docs.map((d) => this.view(d));
  }

  /** Foto del comprobante. Con `organizationId`, solo si el pago es de ese negocio. */
  async proofUrl(id: string, organizationId?: string) {
    const payment = await this.payments.findOne({ _id: id, ...(organizationId && { organizationId }) }).exec();
    if (!payment?.proofKey) throw Errors.notFound('Comprobante');
    return { url: await this.storage.url(payment.proofKey) };
  }

  uploadProof(organizationId: string, buffer: Buffer) {
    return this.storage.putImage(`billing/${organizationId}`, buffer).then((key) => ({ key }));
  }

  /** Activa el plan pagado y extiende el periodo desde hoy o desde el vencimiento vigente. */
  async approve(id: string, reviewerId: string) {
    const payment = await this.payments.findOne({ _id: id, status: 'pending' }).exec();
    if (!payment) throw Errors.notFound('Pago pendiente');
    const sub = await this.subscriptions.findOne({ organizationId: payment.organizationId }).exec();
    if (!sub) throw Errors.notFound('Suscripción');

    const now = new Date();
    const paidUntil = sub.status === 'active' && sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
    const periodEnd = addPeriod(paidUntil, payment.billingCycle);
    sub.set({ planCode: payment.planCode, billingCycle: payment.billingCycle, status: 'active', currentPeriodEnd: periodEnd });
    await sub.save();
    payment.set({ status: 'approved', reviewedBy: reviewerId, reviewedAt: now, periodStart: paidUntil, periodEnd });
    await payment.save();
    this.entitlements.invalidate(payment.organizationId.toString());
    await this.audit.log({
      action: 'billing.payment_approved',
      organizationId: payment.organizationId.toString(),
      actorUserId: reviewerId,
      entityType: 'SubscriptionPayment',
      entityId: id,
      metadata: { planCode: payment.planCode, periodEnd },
    });
    return this.view(payment);
  }

  async reject(id: string, reviewerId: string, reason: string) {
    const payment = await this.payments.findOne({ _id: id, status: 'pending' }).exec();
    if (!payment) throw Errors.notFound('Pago pendiente');
    payment.set({ status: 'rejected', reviewedBy: reviewerId, reviewedAt: new Date(), rejectReason: reason });
    await payment.save();
    await this.audit.log({
      action: 'billing.payment_rejected',
      organizationId: payment.organizationId.toString(),
      actorUserId: reviewerId,
      entityType: 'SubscriptionPayment',
      entityId: id,
      metadata: { reason },
    });
    return this.view(payment);
  }

  private view(p: SubscriptionPaymentDocument) {
    return {
      id: p.id as string,
      organizationId: p.organizationId.toString(),
      planCode: p.planCode,
      billingCycle: p.billingCycle,
      amount: p.amount,
      currency: p.currency,
      method: p.method,
      reference: p.reference,
      paidOn: p.paidOn,
      note: p.note ?? '',
      status: p.status,
      rejectReason: p.rejectReason ?? null,
      hasProof: !!p.proofKey,
      periodEnd: p.periodEnd,
      createdAt: (p as unknown as { createdAt: Date }).createdAt,
    };
  }
}
