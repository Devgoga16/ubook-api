import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types, type Connection, type Model } from 'mongoose';
import { AuditService } from '../../core/audit/audit.service.js';
import { OWNER_ROLE_KEY } from '../../core/authorization/permissions.catalog.js';
import { Errors } from '../../core/common/errors.js';
import { StorageService } from '../../core/storage/storage.service.js';
import { User } from '../identity/schemas/user.schema.js';
import { Organization } from '../organization/schemas/organization.schema.js';
import { BillingService } from '../platform/billing.service.js';
import { effectiveStatus, EntitlementsService } from '../platform/entitlements.service.js';
import { FEATURES, FEATURE_KEYS } from '../platform/features.catalog.js';
import { PlansService } from '../platform/plans.service.js';
import { SubscriptionsService } from '../platform/subscriptions.service.js';

const DUPLICATE_KEY = 11000;

export interface PlatformOrgUpdate {
  name?: string;
  slug?: string;
  businessType?: string;
  timezone?: string;
}

export interface PlatformOwnerUpdate {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string | null;
}

/**
 * La cuenta de un negocio vista por Unify Tec: datos del negocio, dueño,
 * suscripción, pagos y uso. Lee las colecciones del negocio directamente
 * (filtrando por organizationId) porque la plataforma no opera dentro de un tenant.
 */
@Injectable()
export class PlatformOrganizationsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Organization.name) private readonly organizations: Model<Organization>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly subscriptions: SubscriptionsService,
    private readonly plans: PlansService,
    private readonly entitlements: EntitlementsService,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Borra el negocio y TODO lo suyo: cada documento con su organizationId en cualquier
   * colección (incluidas las que se agreguen en el futuro), sus archivos (comprobantes),
   * y las cuentas de usuario que solo pertenecían a este negocio.
   * Es idempotente: si se corta a la mitad, se puede volver a ejecutar; el negocio se
   * borra al final y antes se suspende para que nadie lo use mientras tanto.
   */
  async remove(id: string, confirm: string, actorUserId: string) {
    const org = await this.organizations.findById(id).exec();
    if (!org) throw Errors.notFound('Negocio');
    if (confirm.trim().toLowerCase() !== org.slug) {
      throw Errors.badRequest('CONFIRMATION_MISMATCH', `Escribe "${org.slug}" para confirmar`);
    }
    const orgId = org._id;
    const db = this.connection.db!;
    await this.organizations.updateOne({ _id: orgId }, { $set: { status: 'suspended' } }).exec();
    this.entitlements.invalidate(id);

    // Personas del negocio (antes de borrar sus membresías).
    const memberIds: Types.ObjectId[] = await db.collection('memberships').distinct('userId', { organizationId: orgId });

    // Archivos privados del negocio.
    const files = (await Promise.all(['deposits', 'billing', 'logos'].map((p) => this.storage.deletePrefix(`${p}/${id}`)))).reduce((a, b) => a + b, 0);

    // Todas las colecciones con datos del negocio.
    const removed: Record<string, number> = {};
    for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
      if (name.startsWith('system.') || name === 'organizations') continue;
      const { deletedCount } = await db.collection(name).deleteMany({ organizationId: orgId });
      if (deletedCount) removed[name] = deletedCount;
    }

    // Cuentas que solo existían por este negocio (nunca personal de la plataforma).
    const stillMember = new Set(
      ((await db.collection('memberships').distinct('userId', { userId: { $in: memberIds } })) as Types.ObjectId[]).map(String),
    );
    const orphanIds = memberIds.filter((u) => !stillMember.has(String(u)));
    const orphans = (await this.users.find({ _id: { $in: orphanIds }, platformRole: null }).select('_id').lean().exec()).map((u) => u._id);
    if (orphans.length) {
      await db.collection('sessions').deleteMany({ userId: { $in: orphans } });
      await this.users.deleteMany({ _id: { $in: orphans } }).exec();
    }

    await this.organizations.deleteOne({ _id: orgId }).exec();
    this.entitlements.invalidate(id);

    const summary = { name: org.name, slug: org.slug, removed, files, users: orphans.length };
    // Queda registro en la plataforma (sin organizationId: el negocio ya no existe).
    await this.audit.log({
      action: 'platform.organization_deleted',
      entityType: 'Organization',
      entityId: id,
      organizationId: undefined,
      actorUserId,
      metadata: summary,
    });
    return summary;
  }

  async detail(id: string) {
    const org = await this.organizations.findById(id).exec();
    if (!org) throw Errors.notFound('Negocio');
    const orgId = org._id;
    const db = this.connection;
    const count = (collection: string, filter: Record<string, unknown> = {}) => db.collection(collection).countDocuments({ organizationId: orgId, ...filter });
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

    const [sub, owners, ent, payments, usage] = await Promise.all([
      this.subscriptions.findByOrganization(id),
      this.owners(orgId),
      this.entitlements.get(id),
      this.billing.listForOrganization(id),
      Promise.all([
        count('branches', { isActive: true }),
        count('professionals', { isActive: true }),
        count('memberships', { status: 'active' }),
        count('clients'),
        count('appointments'),
        count('appointments', { createdAt: { $gte: monthStart } }),
        count('appointments', { channel: 'online' }),
      ]),
    ]);
    if (!sub) throw Errors.notFound('Suscripción');
    const plan = await this.plans.getByCode(sub.planCode).catch(() => null);

    return {
      organization: {
        id: org.id as string,
        name: org.name,
        slug: org.slug,
        businessType: org.businessType ?? null,
        timezone: org.timezone,
        country: org.country,
        currency: org.currency,
        status: org.status,
        createdAt: (org as unknown as { createdAt: Date }).createdAt,
      },
      owners,
      subscription: {
        planCode: sub.planCode,
        status: sub.status,
        effectiveStatus: effectiveStatus(sub),
        billingCycle: sub.billingCycle ?? 'monthly',
        trialEndsAt: sub.trialEndsAt ?? null,
        currentPeriodEnd: sub.currentPeriodEnd ?? null,
        readOnly: ent.readOnly,
        features: FEATURE_KEYS.map((key) => ({
          key,
          label: FEATURES[key].label,
          type: FEATURES[key].type,
          plan: plan?.features.has(key) ? plan.features.get(key) : null,
          override: sub.overrides.has(key) ? sub.overrides.get(key) : undefined,
          effective: ent.features[key],
        })),
      },
      usage: {
        branches: usage[0],
        professionals: usage[1],
        members: usage[2],
        clients: usage[3],
        appointments: usage[4],
        appointmentsThisMonth: usage[5],
        onlineBookings: usage[6],
      },
      payments,
    };
  }

  async update(id: string, dto: PlatformOrgUpdate, actorUserId: string) {
    const org = await this.organizations.findById(id).exec();
    if (!org) throw Errors.notFound('Negocio');
    if (dto.slug && dto.slug !== org.slug && (await this.organizations.exists({ slug: dto.slug }))) {
      throw Errors.conflict('SLUG_TAKEN', 'Esa dirección ya está en uso por otro negocio');
    }
    org.set(dto);
    await org.save();
    await this.audit.log({ action: 'platform.organization_updated', organizationId: id, actorUserId, entityType: 'Organization', entityId: id, metadata: { ...dto } });
    return this.detail(id);
  }

  /** Datos de la cuenta del dueño (con quien se inicia sesión). */
  async updateOwner(id: string, userId: string, dto: PlatformOwnerUpdate, actorUserId: string) {
    const owners = await this.owners(new Types.ObjectId(id));
    if (!owners.some((o) => o.userId === userId)) throw Errors.notFound('Dueño');
    const user = await this.users.findById(userId).exec();
    if (!user) throw Errors.notFound('Usuario');
    const email = dto.email?.trim().toLowerCase();
    if (email && email !== user.email && (await this.users.exists({ email }))) {
      throw Errors.conflict('EMAIL_TAKEN', 'Ya existe otra cuenta con ese correo');
    }
    user.set({ ...dto, ...(email && { email }), ...(dto.phone === null && { phone: undefined }) });
    try {
      await user.save();
    } catch (error) {
      if ((error as { code?: number }).code === DUPLICATE_KEY) throw Errors.conflict('EMAIL_TAKEN', 'Ya existe otra cuenta con ese correo');
      throw error;
    }
    await this.audit.log({
      action: 'platform.owner_updated',
      organizationId: id,
      actorUserId,
      entityType: 'User',
      entityId: userId,
      metadata: { fields: Object.keys(dto) },
    });
    return this.detail(id);
  }

  /** Usuarios con el rol Dueño activo en el negocio. */
  private async owners(orgId: Types.ObjectId) {
    const role = await this.connection.collection('roles').findOne({ organizationId: orgId, templateKey: OWNER_ROLE_KEY });
    if (!role) return [];
    const memberships = await this.connection.collection('memberships').find({ organizationId: orgId, roleIds: role._id, status: 'active' }).toArray();
    const users = await this.users.find({ _id: { $in: memberships.map((m) => m.userId) } }).exec();
    return users.map((u) => ({
      userId: u.id as string,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      phone: u.phone ?? null,
      lastLoginAt: u.lastLoginAt ?? null,
      isActive: u.isActive,
    }));
  }
}
