import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import type { Env } from '../../config/env.js';
import { utcToZoned } from '../../core/scheduling/zoned-time.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { Client } from '../clients/schemas/client.schema.js';
import { Organization } from '../organization/schemas/organization.schema.js';
import { AutomationSettings, NotificationLog } from './automations/automation.schemas.js';
import { AutomationsService } from './automations/automations.service.js';
import { BookingMailerService } from './booking-mailer.service.js';
import { Appointment } from './schemas/appointment.schema.js';

const HOUR = 3_600_000;
const EVERY = 5 * 60_000;
/** Los flujos diarios (reactivar, cumpleaños) salen desde esta hora local. */
const DAILY_HOUR = 10;

/**
 * Automatizaciones programadas. Cada 5 minutos: recordatorios (según las horas
 * que eligió cada negocio), pedidos de reseña y, una vez al día, reactivación
 * y cumpleaños. Marcar antes de enviar evita duplicados aunque corran varias
 * instancias de la API.
 */
@Injectable()
export class BookingRemindersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Automatizaciones');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectModel(Appointment.name) private readonly appointments: Model<Appointment>,
    @InjectModel(AutomationSettings.name) private readonly settings: Model<AutomationSettings>,
    @InjectModel(NotificationLog.name) private readonly logs: Model<NotificationLog>,
    @InjectModel(Client.name) private readonly clients: Model<Client>,
    @InjectModel(Organization.name) private readonly organizations: Model<Organization>,
    private readonly mailer: BookingMailerService,
    private readonly automations: AutomationsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    if (this.config.get('NODE_ENV', { infer: true }) === 'test') return;
    this.timer = setInterval(() => void this.tick().catch((e: Error) => this.logger.error(e.message)), EVERY);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<void> {
    await this.run(now);
    await this.runReviews(now);
    await this.runDaily(now);
  }

  /** Horas de anticipación del recordatorio por negocio (por defecto 24). */
  private async settingsByOrg(orgIds: Types.ObjectId[]) {
    const docs = await TenantContext.runAsSystem(() => this.settings.find({ organizationId: { $in: orgIds } }).exec());
    return new Map(docs.map((d) => [d.organizationId.toString(), d]));
  }

  /**
   * Recordatorios: citas confirmadas que empiezan dentro de las horas elegidas
   * (y en más de 1 h), reservadas con al menos la mitad de esa anticipación.
   */
  async run(now = new Date()): Promise<number> {
    const due = await TenantContext.runAsSystem(() =>
      this.appointments
        .find({ status: 'confirmed', reminderSentAt: null, startsAt: { $gt: new Date(now.getTime() + HOUR), $lte: new Date(now.getTime() + 72 * HOUR) } })
        .select('organizationId startsAt createdAt')
        .limit(1000)
        .exec(),
    );
    const byOrg = await this.settingsByOrg(due.map((a) => a.organizationId));
    let sent = 0;
    for (const appt of due) {
      const s = byOrg.get(appt.organizationId.toString());
      if (s && !s.reminder.enabled) continue;
      const hours = s?.reminder.offset ?? 24;
      if (appt.startsAt.getTime() - now.getTime() > hours * HOUR) continue;
      const createdAt = (appt as unknown as { createdAt: Date }).createdAt;
      const claimed = await TenantContext.runAsSystem(() => this.appointments.updateOne({ _id: appt._id, reminderSentAt: null }, { reminderSentAt: now }).exec());
      if (claimed.modifiedCount === 0) continue;
      if (appt.startsAt.getTime() - createdAt.getTime() < (hours / 2) * HOUR) continue;
      if (await TenantContext.runForOrganization(appt.organizationId.toString(), () => this.mailer.notify('reminder', appt.id as string))) sent += 1;
    }
    if (sent) this.logger.log(`${sent} recordatorios enviados`);
    return sent;
  }

  /** Pedido de reseña: X horas después de terminar una cita completada. */
  async runReviews(now = new Date()): Promise<number> {
    const enabled = await TenantContext.runAsSystem(() => this.settings.find({ 'review.enabled': true }).exec());
    let sent = 0;
    for (const s of enabled) {
      const hours = s.review.offset ?? 2;
      const due = await TenantContext.runAsSystem(() =>
        this.appointments
          .find({
            organizationId: s.organizationId,
            status: 'completed',
            reviewRequestedAt: null,
            endsAt: { $gte: new Date(now.getTime() - (hours + 6) * HOUR), $lte: new Date(now.getTime() - hours * HOUR) },
          })
          .select('_id')
          .limit(200)
          .exec(),
      );
      for (const appt of due) {
        const claimed = await TenantContext.runAsSystem(() => this.appointments.updateOne({ _id: appt._id, reviewRequestedAt: null }, { reviewRequestedAt: now }).exec());
        if (claimed.modifiedCount === 0) continue;
        sent += await TenantContext.runForOrganization(s.organizationId.toString(), () => this.automations.dispatch('review', { appointmentId: appt.id as string }));
      }
    }
    return sent;
  }

  /** Reactivar clientes y cumpleaños: una vez al día por negocio, desde las 10 a. m. */
  async runDaily(now = new Date()): Promise<number> {
    const active = await TenantContext.runAsSystem(() => this.settings.find({ $or: [{ 'reactivation.enabled': true }, { 'birthday.enabled': true }] }).exec());
    let sent = 0;
    for (const s of active) {
      const orgId = s.organizationId.toString();
      const org = await this.organizations.findById(orgId).select('timezone status').exec();
      if (!org || org.status !== 'active') continue;
      const local = utcToZoned(now, org.timezone);
      if (local.minutes < DAILY_HOUR * 60) continue;
      const claimed = await TenantContext.runAsSystem(() =>
        this.settings.updateOne({ _id: s._id, lastDailyRun: { $ne: local.date } }, { lastDailyRun: local.date }).exec(),
      );
      if (claimed.modifiedCount === 0) continue;
      sent += await TenantContext.runForOrganization(orgId, async () => {
        let n = 0;
        if (s.reactivation.enabled) n += await this.reactivate(s.reactivation.offset ?? 45, now);
        if (s.birthday.enabled) n += await this.birthdays(local.date);
        return n;
      });
    }
    return sent;
  }

  /** Clientes cuya última visita cumple justo hoy los días elegidos, sin cita próxima ni aviso reciente. */
  private async reactivate(days: number, now: Date): Promise<number> {
    const from = new Date(now.getTime() - (days + 1) * 24 * HOUR);
    const to = new Date(now.getTime() - days * 24 * HOUR);
    const last = await this.appointments.aggregate<{ _id: Types.ObjectId; lastVisit: Date }>([
      { $match: { status: 'completed' } },
      { $group: { _id: '$clientId', lastVisit: { $max: '$startsAt' } } },
      { $match: { lastVisit: { $gte: from, $lt: to } } },
      { $limit: 500 },
    ]);
    let n = 0;
    for (const { _id: clientId } of last) {
      if (await this.appointments.exists({ clientId, status: { $in: ['pending', 'confirmed'] }, startsAt: { $gt: now } })) continue;
      if (await this.logs.exists({ flow: 'reactivation', clientId, createdAt: { $gte: new Date(now.getTime() - 60 * 24 * HOUR) } })) continue;
      n += await this.automations.dispatch('reactivation', { clientId: clientId.toString() });
    }
    return n;
  }

  /** Cumpleaños de hoy (una vez al año por cliente). */
  private async birthdays(today: string): Promise<number> {
    const monthDay = today.slice(5);
    const yearStart = new Date(`${today.slice(0, 4)}-01-01T00:00:00Z`);
    const list = await this.clients.find({ birthDate: { $regex: `-${monthDay}$` }, marketingConsent: true }).select('_id').limit(500).exec();
    let n = 0;
    for (const c of list) {
      if (await this.logs.exists({ flow: 'birthday', clientId: c._id, createdAt: { $gte: yearStart } })) continue;
      n += await this.automations.dispatch('birthday', { clientId: c.id as string });
    }
    return n;
  }
}

