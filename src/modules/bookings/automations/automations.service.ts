import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Errors } from '../../../core/common/errors.js';
import { MailService } from '../../../core/mail/mail.service.js';
import { messageEmail } from '../../../core/mail/templates.js';
import { WhatsAppService } from '../../../core/mail/whatsapp.service.js';
import { TenantContext } from '../../../core/tenancy/tenant-context.js';
import { Client } from '../../clients/schemas/client.schema.js';
import { User } from '../../identity/schemas/user.schema.js';
import { Branch } from '../../organization/schemas/branch.schema.js';
import { Organization } from '../../organization/schemas/organization.schema.js';
import { EntitlementsService } from '../../platform/entitlements.service.js';
import { Professional } from '../../professionals/schemas/professional.schema.js';
import { BookingLinksService } from '../booking-links.service.js';
import { Appointment, type AppointmentDocument } from '../schemas/appointment.schema.js';
import {
  AutomationSettings,
  FLOWS,
  MARKETING_FLOWS,
  NotificationLog,
  type AutomationSettingsDocument,
  type Channel,
  type FlowKey,
  type FlowSettings,
} from './automation.schemas.js';
import { DEFAULT_MESSAGES, PROMO_SUFFIX, renderMessage, unknownVariables, VARIABLES, type MessageVars } from './render.js';

const SUBJECTS: Record<FlowKey, string> = {
  reminder: 'Recordatorio de tu cita',
  confirmation: 'Tu cita está agendada',
  review: '¿Cómo te fue?',
  reactivation: 'Te extrañamos',
  birthday: '¡Feliz cumpleaños!',
  noShow: 'Te esperábamos hoy',
};

export interface FlowUpdate {
  enabled?: boolean;
  channels?: Channel[];
  offset?: number | null;
  message?: string;
  promoCode?: string | null;
  link?: string | null;
}

/**
 * Automatizaciones: qué mensajes se envían, por qué canal y con qué texto.
 * Todo envío queda en el registro (enviado o fallido) y respeta el plan y el
 * consentimiento del cliente.
 */
@Injectable()
export class AutomationsService {
  private readonly logger = new Logger('Automatizaciones');

  constructor(
    @InjectModel(AutomationSettings.name) private readonly settings: Model<AutomationSettings>,
    @InjectModel(NotificationLog.name) private readonly logs: Model<NotificationLog>,
    @InjectModel(Appointment.name) private readonly appointments: Model<Appointment>,
    @InjectModel(Client.name) private readonly clients: Model<Client>,
    @InjectModel(Branch.name) private readonly branches: Model<Branch>,
    @InjectModel(Professional.name) private readonly professionals: Model<Professional>,
    @InjectModel(Organization.name) private readonly organizations: Model<Organization>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly entitlements: EntitlementsService,
    private readonly links: BookingLinksService,
    private readonly mail: MailService,
    private readonly whatsapp: WhatsAppService,
  ) {}

  /* ---------- Configuración ---------- */

  /** Configuración del negocio actual (se crea con valores por defecto la primera vez). */
  async current(): Promise<AutomationSettingsDocument> {
    return (await this.settings.findOne().exec()) ?? (await this.settings.findOneAndUpdate({}, {}, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }).exec())!;
  }

  async flow(flow: FlowKey): Promise<FlowSettings> {
    return (await this.current())[flow];
  }

  async overview() {
    const s = await this.current();
    const features = (await this.entitlements.get(TenantContext.requireOrganizationId())).features;
    const since = new Date(Date.now() - 30 * 86_400_000);
    const stats = await this.logs.aggregate<{ _id: { flow: string; status: string }; n: number }>([
      // El plugin de tenant agrega el filtro del negocio.
      { $match: { createdAt: { $gte: since }, test: false } },
      { $group: { _id: { flow: '$flow', status: '$status' }, n: { $sum: 1 } } },
    ]);
    return {
      flows: Object.fromEntries(FLOWS.map((f) => [f, (s.toObject() as unknown as Record<FlowKey, FlowSettings>)[f]])),
      defaults: DEFAULT_MESSAGES,
      variables: VARIABLES,
      stats: stats.map((x) => ({ flow: x._id.flow, status: x._id.status, count: x.n })),
      channels: {
        email: features.email_notifications === true,
        whatsapp: features.whatsapp === true,
        whatsappStatus: await this.whatsapp.status(),
      },
    };
  }

  async update(flow: FlowKey, dto: FlowUpdate) {
    if (dto.message && unknownVariables(dto.message).length) {
      throw Errors.badRequest('UNKNOWN_VARIABLE', `Variable desconocida: {{${unknownVariables(dto.message)[0]}}}`);
    }
    if (flow === 'review' && dto.enabled && !(dto.link ?? (await this.flow('review')).link)) {
      throw Errors.badRequest('LINK_REQUIRED', 'Pega el enlace donde tus clientes dejan reseñas (Google, Facebook…)');
    }
    const s = await this.current();
    s.set(Object.fromEntries(Object.entries(dto).map(([k, v]) => [`${flow}.${k}`, v])));
    await s.save();
    return this.overview();
  }

  async log(limit = 50) {
    const docs = await this.logs.find().sort({ createdAt: -1 }).limit(limit).exec();
    const clients = await this.clients.find({ _id: { $in: docs.map((d) => d.clientId).filter(Boolean) } }).select('firstName lastName').exec();
    return docs.map((d) => {
      const c = clients.find((x) => d.clientId && x._id.equals(d.clientId));
      return {
        id: d.id as string,
        flow: d.flow,
        channel: d.channel,
        to: d.to,
        status: d.status,
        error: d.error ?? null,
        test: d.test,
        clientName: c ? `${c.firstName} ${c.lastName}`.trim() : null,
        createdAt: (d as unknown as { createdAt: Date }).createdAt,
      };
    });
  }

  /* ---------- Envío ---------- */

  /**
   * Envía un flujo a un cliente por los canales activos. Para citas, el
   * correo de confirmación y recordatorio lo arma BookingMailer (más completo);
   * aquí se manda el WhatsApp con el texto del negocio.
   */
  async dispatch(flow: FlowKey, target: { appointmentId?: string; clientId?: string }, opts: { channels?: Channel[] } = {}): Promise<number> {
    const settings = await this.flow(flow);
    if (!settings.enabled) return 0;
    const appt = target.appointmentId ? await this.appointments.findById(target.appointmentId).exec() : null;
    const clientId = appt?.clientId.toString() ?? target.clientId;
    const client = clientId ? await this.clients.findById(clientId).exec() : null;
    if (!client) return 0;
    if (MARKETING_FLOWS.includes(flow) && !client.marketingConsent) return 0;

    const features = (await this.entitlements.get(TenantContext.requireOrganizationId())).features;
    const vars = await this.vars(flow, settings, appt, client.firstName);
    const text = this.text(flow, settings, vars);
    let sent = 0;
    for (const channel of opts.channels ?? settings.channels) {
      if (channel === 'email' && client.email && features.email_notifications === true) {
        const cta = this.cta(flow, vars);
        const ok = await this.mail.send(messageEmail({ to: client.email, subject: SUBJECTS[flow], organizationName: vars.negocio ?? '', text, cta }));
        await this.record(flow, 'email', client.email, ok ? null : 'No se pudo enviar el correo', { clientId: client.id as string, appointmentId: appt?.id as string | undefined });
        if (ok) sent++;
      }
      if (channel === 'whatsapp' && client.phone && features.whatsapp === true) {
        const res = await this.whatsapp.send({ to: client.phone, text });
        await this.record(flow, 'whatsapp', client.phone, res.ok ? null : (res.error ?? 'Error'), { clientId: client.id as string, appointmentId: appt?.id as string | undefined });
        if (res.ok) sent++;
      }
    }
    return sent;
  }

  /** Envío de prueba al usuario que lo pide (correo y celular de su cuenta). */
  async test(flow: FlowKey, userId: string) {
    const settings = await this.flow(flow);
    const user = await this.users.findById(userId).select('firstName email phone').exec();
    if (!user) throw Errors.notFound('Usuario');
    const vars = await this.vars(flow, settings, null, user.firstName, true);
    const text = this.text(flow, settings, vars);
    const features = (await this.entitlements.get(TenantContext.requireOrganizationId())).features;
    const result = { email: false, whatsapp: false, text };
    if (settings.channels.includes('email') && features.email_notifications === true) {
      result.email = await this.mail.send(messageEmail({ to: user.email, subject: `[Prueba] ${SUBJECTS[flow]}`, organizationName: vars.negocio ?? '', text, cta: this.cta(flow, vars) }));
      await this.record(flow, 'email', user.email, result.email ? null : 'No se pudo enviar el correo', { test: true });
    }
    if (settings.channels.includes('whatsapp') && features.whatsapp === true && user.phone) {
      const res = await this.whatsapp.send({ to: user.phone, text });
      result.whatsapp = res.ok;
      await this.record(flow, 'whatsapp', user.phone, res.ok ? null : (res.error ?? 'Error'), { test: true });
    }
    return result;
  }

  /** WhatsApp de una cita (confirmación/recordatorio), si el flujo lo usa y el plan lo incluye. */
  async whatsappForAppointment(flow: FlowKey, appt: AppointmentDocument): Promise<boolean> {
    const settings = await this.flow(flow);
    if (!settings.enabled || !settings.channels.includes('whatsapp')) return false;
    return (await this.dispatch(flow, { appointmentId: appt.id as string }, { channels: ['whatsapp'] })) > 0;
  }

  async record(flow: string, channel: Channel, to: string, error: string | null, ids: { clientId?: string; appointmentId?: string; test?: boolean }) {
    try {
      await this.logs.create({ flow, channel, to, status: error ? 'failed' : 'sent', error: error ?? undefined, clientId: ids.clientId ?? null, appointmentId: ids.appointmentId ?? null, test: ids.test ?? false });
    } catch (e) {
      this.logger.error(`No se pudo registrar el envío: ${(e as Error).message}`);
    }
  }

  /* ---------- Internos ---------- */

  private text(flow: FlowKey, s: FlowSettings, vars: MessageVars): string {
    const base = s.message?.trim() || DEFAULT_MESSAGES[flow];
    const withPromo = s.promoCode && !base.includes('{{cupon}}') ? base + PROMO_SUFFIX : base;
    return renderMessage(withPromo, vars);
  }

  private cta(flow: FlowKey, vars: MessageVars): { label: string; url: string } | undefined {
    if (flow === 'review' && vars['link.resena']) return { label: 'Dejar mi reseña', url: vars['link.resena'] };
    if ((flow === 'reminder' || flow === 'confirmation') && vars['link.gestionar']) return { label: 'Ver, cambiar o cancelar', url: vars['link.gestionar'] };
    if (vars['link.reservar']) return { label: 'Reservar ahora', url: vars['link.reservar'] };
    return undefined;
  }

  /** Datos del mensaje. Con `sample`, valores de ejemplo para la prueba. */
  private async vars(flow: FlowKey, s: FlowSettings, appt: AppointmentDocument | null, firstName: string, sample = false): Promise<MessageVars> {
    const org = await this.organizations.findById(TenantContext.requireOrganizationId()).select('name slug timezone').exec();
    const vars: MessageVars = {
      'cliente.nombre': firstName,
      negocio: org?.name ?? '',
      'link.reservar': this.mail.appUrl(`/reservar/${org?.slug ?? ''}`),
      'link.resena': s.link ?? '',
      cupon: s.promoCode ?? '',
    };
    if (sample) {
      return { ...vars, servicio: 'Corte clásico', profesional: 'Luis', 'cita.fecha': 'martes 13 de octubre', 'cita.hora': '15:00', sucursal: 'Sede principal', 'sucursal.direccion': 'Av. Larco 812', 'link.gestionar': this.mail.appUrl('/reserva/ejemplo') };
    }
    if (!appt) return vars;
    const [branch, pro] = await Promise.all([
      this.branches.findById(appt.branchId).select('name address timezone').exec(),
      this.professionals.findById(appt.professionalId).select('displayName').exec(),
    ]);
    const tz = branch?.timezone ?? org?.timezone ?? 'America/Lima';
    return {
      ...vars,
      servicio: appt.serviceName,
      profesional: pro?.displayName ?? '',
      // "lunes 19 de octubre" (sin la coma de Intl) para que se lea natural en el mensaje.
      'cita.fecha': new Intl.DateTimeFormat('es-PE', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(appt.startsAt).replace(',', ''),
      'cita.hora': new Intl.DateTimeFormat('es-PE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(appt.startsAt),
      sucursal: branch?.name ?? '',
      'sucursal.direccion': branch?.address || branch?.name || '',
      'link.gestionar': this.links.url(appt.id as string),
    };
  }
}
