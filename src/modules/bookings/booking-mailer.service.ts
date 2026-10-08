import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { MailService } from '../../core/mail/mail.service.js';
import { bookingEmail, type BookingEmailKind } from '../../core/mail/templates.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { Client } from '../clients/schemas/client.schema.js';
import { Branch } from '../organization/schemas/branch.schema.js';
import { Organization } from '../organization/schemas/organization.schema.js';
import { EntitlementsService } from '../platform/entitlements.service.js';
import { Professional } from '../professionals/schemas/professional.schema.js';
import { BookingLinksService } from './booking-links.service.js';
import { AutomationsService } from './automations/automations.service.js';
import type { FlowKey } from './automations/automation.schemas.js';
import { Appointment } from './schemas/appointment.schema.js';

/** Aviso → flujo configurable. Los demás (cancelación, cambio) se envían siempre. */
const FLOW_OF: Partial<Record<BookingEmailKind, FlowKey>> = {
  confirmed: 'confirmation',
  pending: 'confirmation',
  approved: 'confirmation',
  reminder: 'reminder',
};

/**
 * Correos al cliente sobre su cita. Solo si el cliente tiene correo y el plan
 * incluye notificaciones. Un fallo se registra y no afecta la operación.
 */
@Injectable()
export class BookingMailerService {
  private readonly logger = new Logger('BookingMailer');

  constructor(
    @InjectModel(Appointment.name) private readonly appointments: Model<Appointment>,
    @InjectModel(Client.name) private readonly clients: Model<Client>,
    @InjectModel(Branch.name) private readonly branches: Model<Branch>,
    @InjectModel(Professional.name) private readonly professionals: Model<Professional>,
    @InjectModel(Organization.name) private readonly organizations: Model<Organization>,
    private readonly entitlements: EntitlementsService,
    private readonly links: BookingLinksService,
    private readonly mail: MailService,
    private readonly automations: AutomationsService,
  ) {}

  /** Se ejecuta dentro del negocio de la cita (contexto de tenant activo). */
  async notify(kind: BookingEmailKind, appointmentId: string): Promise<boolean> {
    try {
      const organizationId = TenantContext.requireOrganizationId();
      const flowKey = FLOW_OF[kind];
      const flow = flowKey ? await this.automations.flow(flowKey) : null;
      if (flow && !flow.enabled) return false;

      const appt = await this.appointments.findById(appointmentId).exec();
      if (!appt) return false;
      // WhatsApp (si el flujo lo usa); el correo sigue abajo con su diseño propio.
      const whatsapp = flowKey ? await this.automations.whatsappForAppointment(flowKey, appt) : false;
      if (flow && !flow.channels.includes('email')) return whatsapp;

      const features = (await this.entitlements.get(organizationId)).features;
      if (features.email_notifications !== true) return whatsapp;
      const client = await this.clients.findById(appt.clientId).select('firstName email').exec();
      if (!client?.email) return whatsapp;
      const [org, branch, pro] = await Promise.all([
        this.organizations.findById(organizationId).select('name slug').exec(),
        this.branches.findById(appt.branchId).select('name address timezone').exec(),
        this.professionals.findById(appt.professionalId).select('displayName').exec(),
      ]);
      if (!org || !branch) return false;

      const ok = await this.mail.send(
        bookingEmail(kind, {
          to: client.email,
          firstName: client.firstName,
          organizationName: org.name,
          serviceName: appt.serviceName,
          professionalName: pro?.displayName ?? 'nuestro equipo',
          branchName: branch.name,
          branchAddress: branch.address,
          startsAt: appt.startsAt,
          timezone: branch.timezone,
          number: appt.number,
          manageUrl: this.links.url(appt.id as string),
          bookingUrl: this.mail.appUrl(`/reservar/${org.slug}`),
        }),
      );
      await this.automations.record(flowKey ?? kind, 'email', client.email, ok ? null : 'No se pudo enviar el correo', {
        clientId: client.id as string,
        appointmentId,
      });
      return ok || whatsapp;
    } catch (error) {
      this.logger.error(`No se pudo enviar "${kind}" de la cita ${appointmentId}: ${(error as Error).message}`);
      return false;
    }
  }
}
