import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter } from 'mongoose';
import { currentScope } from '../../core/authorization/scope.js';
import { Errors } from '../../core/common/errors.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { Membership } from '../organization/schemas/membership.schema.js';
import { Professional } from '../professionals/schemas/professional.schema.js';
import { Notification, type NotificationType } from './notification.schema.js';

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body?: string;
  appointmentId?: string | null;
  branchId?: string | null;
  professionalId?: string | null;
}

const LIST_LIMIT = 30;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');

  constructor(
    @InjectModel(Notification.name) private readonly notifications: Model<Notification>,
    @InjectModel(Membership.name) private readonly memberships: Model<Membership>,
    @InjectModel(Professional.name) private readonly professionals: Model<Professional>,
  ) {}

  /** Registra un aviso en el negocio en contexto. Nunca rompe la operación que lo originó. */
  async notify(input: NotifyInput): Promise<void> {
    try {
      await this.notifications.create({
        type: input.type,
        title: input.title,
        body: input.body ?? '',
        appointmentId: input.appointmentId ?? null,
        branchId: input.branchId ?? null,
        professionalId: input.professionalId ?? null,
      });
    } catch (e) {
      this.logger.error(`No se pudo registrar el aviso ${input.type}: ${(e as Error).message}`);
    }
  }

  /** Últimos avisos que el usuario puede ver, y cuántos no leyó. */
  async list() {
    const filter = await this.scopeFilter();
    const readAt = await this.readAt();
    const [items, unread] = await Promise.all([
      this.notifications.find(filter).sort({ createdAt: -1 }).limit(LIST_LIMIT).exec(),
      this.notifications.countDocuments({ ...filter, ...(readAt && { createdAt: { $gt: readAt } }) }),
    ]);
    return {
      unread,
      items: items.map((n) => ({
        id: n.id as string,
        type: n.type,
        title: n.title,
        body: n.body,
        appointmentId: n.appointmentId?.toString() ?? null,
        createdAt: n.createdAt,
        read: !!readAt && n.createdAt <= readAt,
      })),
    };
  }

  async markAllRead(): Promise<{ unread: 0 }> {
    const access = TenantContext.getAccess();
    if (!access) throw Errors.forbidden();
    await this.memberships.updateOne({ _id: access.membershipId }, { notificationsReadAt: new Date() }).exec();
    return { unread: 0 };
  }

  private async readAt(): Promise<Date | null> {
    const access = TenantContext.getAccess();
    if (!access) return null;
    const m = await this.memberships.findById(access.membershipId).select('notificationsReadAt').exec();
    return m?.notificationsReadAt ?? null;
  }

  /** Mismo alcance que ver citas: todo el negocio, sus sedes o solo su agenda. */
  private async scopeFilter(): Promise<QueryFilter<Notification>> {
    const access = TenantContext.getAccess();
    const scope = currentScope('booking.read');
    if (!access || !scope) throw Errors.forbidden();
    if (scope === 'organization') return {};
    if (scope === 'branch') return access.branchIds.length ? { branchId: { $in: access.branchIds } } : {};
    const mine = await this.professionals.find({ membershipId: access.membershipId }).select('_id').exec();
    return { professionalId: { $in: mine.map((p) => p._id) } };
  }
}
