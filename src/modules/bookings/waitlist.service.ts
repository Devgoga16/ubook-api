import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter } from 'mongoose';
import { AuditService } from '../../core/audit/audit.service.js';
import { canActOn, currentScope } from '../../core/authorization/scope.js';
import { Errors } from '../../core/common/errors.js';
import { MailService } from '../../core/mail/mail.service.js';
import { waitlistEmail } from '../../core/mail/templates.js';
import { addDays, utcToZoned } from '../../core/scheduling/zoned-time.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { Service } from '../catalog/schemas/service.schema.js';
import { Client } from '../clients/schemas/client.schema.js';
import { Branch } from '../organization/schemas/branch.schema.js';
import { Organization } from '../organization/schemas/organization.schema.js';
import { EntitlementsService } from '../platform/entitlements.service.js';
import { Professional } from '../professionals/schemas/professional.schema.js';
import { AppointmentsService } from './appointments.service.js';
import { AvailabilityService } from './availability.service.js';
import type { CreateWaitlistDto } from './dto/waitlist.dto.js';
import { WaitlistEntry, type TimeOfDay, type WaitlistEntryDocument } from './schemas/waitlist.schema.js';

/** Cuántos días hacia adelante se buscan horarios para una persona en espera. */
const LOOKAHEAD_DAYS = 14;
const MAX_OPTIONS = 6;

function fitsTimeOfDay(minutes: number, t: TimeOfDay): boolean {
  if (t === 'morning') return minutes < 12 * 60;
  if (t === 'afternoon') return minutes >= 12 * 60 && minutes < 18 * 60;
  if (t === 'evening') return minutes >= 18 * 60;
  return true;
}

export interface WaitlistOption {
  startsAt: Date;
  professionalId: string;
  professionalName: string;
}

/**
 * Lista de espera: quién espera qué y qué horarios le sirven ahora mismo.
 * Los horarios se calculan al consultar (no se guardan), así siempre están al día.
 */
@Injectable()
export class WaitlistService {
  constructor(
    @InjectModel(WaitlistEntry.name) private readonly entries: Model<WaitlistEntry>,
    @InjectModel(Client.name) private readonly clients: Model<Client>,
    @InjectModel(Service.name) private readonly services: Model<Service>,
    @InjectModel(Professional.name) private readonly professionals: Model<Professional>,
    @InjectModel(Branch.name) private readonly branches: Model<Branch>,
    @InjectModel(Organization.name) private readonly organizations: Model<Organization>,
    private readonly availability: AvailabilityService,
    private readonly appointments: AppointmentsService,
    private readonly entitlements: EntitlementsService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  async list(branchId: string, status: 'waiting' | 'booked' | 'removed' = 'waiting') {
    const branch = await this.branches.findById(branchId).select('timezone').exec();
    if (!branch) throw Errors.notFound('Sucursal');
    const today = utcToZoned(new Date(), branch.timezone).date;
    const docs = await this.entries
      .find({
        branchId,
        status,
        ...(status === 'waiting' && { dateTo: { $gte: today } }),
        ...(await this.scopeFilter()),
      })
      .sort({ createdAt: 1 })
      .limit(100)
      .exec();
    const views = await this.toViews(docs);
    if (status !== 'waiting') return views;
    // Horarios libres que le sirven a cada persona (en paralelo).
    const options = await Promise.all(docs.map((d) => this.optionsFor(d, today).catch(() => [] as WaitlistOption[])));
    return views.map((v, i) => ({ ...v, options: options[i] }));
  }

  async create(dto: CreateWaitlistDto, source: 'backoffice' | 'online' = 'backoffice'): Promise<WaitlistEntryDocument> {
    if (dto.dateTo < dto.dateFrom) throw Errors.badRequest('INVALID_RANGE', 'La fecha final debe ser posterior a la inicial');
    const [client, service, branch] = await Promise.all([
      this.clients.exists({ _id: dto.clientId }),
      this.services.exists({ _id: dto.serviceId, isArchived: false }),
      this.branches.exists({ _id: dto.branchId, isActive: true }),
    ]);
    if (!client) throw Errors.badRequest('INVALID_CLIENT', 'Cliente inválido');
    if (!service) throw Errors.badRequest('INVALID_SERVICE', 'Servicio inválido');
    if (!branch) throw Errors.badRequest('INVALID_BRANCH', 'Sucursal inválida');
    if (dto.professionalId && !(await this.professionals.exists({ _id: dto.professionalId, isActive: true }))) {
      throw Errors.badRequest('INVALID_PROFESSIONAL', 'Profesional inválido');
    }
    // Una sola espera activa por cliente y servicio: se actualiza la existente.
    const existing = await this.entries.findOne({ clientId: dto.clientId, serviceId: dto.serviceId, branchId: dto.branchId, status: 'waiting' }).exec();
    const data = {
      branchId: dto.branchId,
      serviceId: dto.serviceId,
      professionalId: dto.professionalId ?? null,
      clientId: dto.clientId,
      dateFrom: dto.dateFrom,
      dateTo: dto.dateTo,
      timeOfDay: dto.timeOfDay ?? 'any',
      notes: dto.notes,
      source,
    };
    const entry = existing ? existing.set(data) : new this.entries({ ...data, createdBy: TenantContext.getActor()?.userId ?? null });
    await entry.save();
    await this.audit.log({ action: existing ? 'waitlist.updated' : 'waitlist.created', entityType: 'WaitlistEntry', entityId: entry.id as string, metadata: { source } });
    return entry;
  }

  async update(id: string, dto: { status?: 'waiting' | 'removed'; notes?: string }) {
    const entry = await this.findScoped(id);
    entry.set(dto);
    await entry.save();
    return (await this.toViews([entry]))[0]!;
  }

  /** Agenda la cita desde la lista y marca a la persona como atendida. */
  async book(id: string, professionalId: string, startsAt: Date) {
    const entry = await this.findScoped(id);
    if (entry.status !== 'waiting') throw Errors.badRequest('NOT_WAITING', 'Esta persona ya no está en espera');
    const appt = await this.appointments.create({
      branchId: entry.branchId.toString(),
      serviceId: entry.serviceId.toString(),
      professionalId,
      clientId: entry.clientId.toString(),
      startsAt,
      notes: entry.notes ? `Desde lista de espera: ${entry.notes}` : 'Desde lista de espera',
    });
    entry.set({ status: 'booked', appointmentId: appt.id });
    await entry.save();
    await this.audit.log({ action: 'waitlist.booked', entityType: 'WaitlistEntry', entityId: id, metadata: { appointmentId: appt.id } });
    return appt;
  }

  /** Avisa por correo (si tiene y el plan lo incluye) y devuelve el texto para WhatsApp. */
  async notify(id: string) {
    const entry = await this.findScoped(id);
    const branch = await this.branches.findById(entry.branchId).select('timezone').exec();
    const today = utcToZoned(new Date(), branch?.timezone ?? 'America/Lima').date;
    const options = await this.optionsFor(entry, today);
    if (!options.length) throw Errors.badRequest('NO_OPTIONS', 'Por ahora no hay horarios libres que le sirvan');

    const orgId = TenantContext.requireOrganizationId();
    const [client, service, org, features] = await Promise.all([
      this.clients.findById(entry.clientId).select('firstName email phone').exec(),
      this.services.findById(entry.serviceId).select('name').exec(),
      this.organizations.findById(orgId).select('name slug').exec(),
      this.entitlements.get(orgId).then((e) => e.features),
    ]);
    const fmt = new Intl.DateTimeFormat('es-PE', { timeZone: branch?.timezone ?? 'America/Lima', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true });
    const lines = options.slice(0, 3).map((o) => `${fmt.format(o.startsAt)} con ${o.professionalName}`);
    const bookingUrl = this.mail.appUrl(`/reservar/${org?.slug ?? ''}`);

    let emailSent = false;
    if (client?.email && features.email_notifications === true) {
      emailSent = await this.mail.send(
        waitlistEmail({ to: client.email, firstName: client.firstName, organizationName: org?.name ?? '', serviceName: service?.name ?? '', options: lines, bookingUrl }),
      );
    }
    entry.notifiedAt = new Date();
    await entry.save();
    await this.audit.log({ action: 'waitlist.notified', entityType: 'WaitlistEntry', entityId: id, metadata: { emailSent } });
    return {
      emailSent,
      phone: client?.phone ?? null,
      whatsappText: `Hola ${client?.firstName ?? ''}, se liberó un horario en ${org?.name ?? 'el negocio'} para ${service?.name ?? 'tu servicio'}: ${lines.join('; ')}. ¿Te lo reservamos? También puedes reservar aquí: ${bookingUrl}`,
    };
  }

  /* ---------- Internos ---------- */

  /** Horarios libres que coinciden con lo que pidió (fechas, profesional y momento del día). */
  private async optionsFor(entry: WaitlistEntryDocument, today: string): Promise<WaitlistOption[]> {
    const from = entry.dateFrom > today ? entry.dateFrom : today;
    const limit = addDays(from, LOOKAHEAD_DAYS - 1);
    const to = entry.dateTo < limit ? entry.dateTo : limit;
    if (to < from) return [];
    const result = await this.availability.compute({
      branchId: entry.branchId.toString(),
      serviceId: entry.serviceId.toString(),
      professionalId: entry.professionalId?.toString(),
      from,
      to,
      applyRules: true,
    });
    const options: WaitlistOption[] = [];
    for (const p of result.professionals) {
      for (const day of p.days) {
        for (const s of day.slots) {
          if (!s.available) continue;
          if (!fitsTimeOfDay(utcToZoned(s.start, result.timezone).minutes, entry.timeOfDay)) continue;
          options.push({ startsAt: s.start, professionalId: p.professionalId, professionalName: p.displayName });
        }
      }
    }
    // Primero lo más cercano; sin repetir la misma hora con otro profesional.
    const seen = new Set<number>();
    return options
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .filter((o) => !seen.has(o.startsAt.getTime()) && seen.add(o.startsAt.getTime()))
      .slice(0, MAX_OPTIONS);
  }

  private async scopeFilter(): Promise<QueryFilter<WaitlistEntry>> {
    const access = TenantContext.getAccess();
    const scope = currentScope('booking.read');
    if (!access || !scope) throw Errors.forbidden();
    if (scope === 'own') {
      const mine = await this.professionals.find({ membershipId: access.membershipId }).select('_id').exec();
      return { professionalId: { $in: mine.map((p) => p._id) } };
    }
    if (scope === 'branch' && access.branchIds.length) return { branchId: { $in: access.branchIds } };
    return {};
  }

  private async findScoped(id: string): Promise<WaitlistEntryDocument> {
    const entry = await this.entries.findOne({ _id: id, ...(await this.scopeFilter()) }).exec();
    if (!entry) throw Errors.notFound('Persona en espera');
    if (!canActOn('booking.create', { branchIds: [entry.branchId.toString()] }) && currentScope('booking.create') !== 'own') throw Errors.forbidden();
    return entry;
  }

  private async toViews(docs: WaitlistEntryDocument[]) {
    const [clients, services, pros] = await Promise.all([
      this.clients.find({ _id: { $in: docs.map((d) => d.clientId) } }).select('firstName lastName phone email').exec(),
      this.services.find({ _id: { $in: docs.map((d) => d.serviceId) } }).select('name durationMinutes').exec(),
      this.professionals.find({ _id: { $in: docs.map((d) => d.professionalId).filter(Boolean) } }).select('displayName').exec(),
    ]);
    return docs.map((d) => {
      const c = clients.find((x) => x._id.equals(d.clientId));
      return {
        id: d.id as string,
        branchId: d.branchId.toString(),
        serviceId: d.serviceId.toString(),
        serviceName: services.find((x) => x._id.equals(d.serviceId))?.name ?? '',
        professionalId: d.professionalId?.toString() ?? null,
        professionalName: d.professionalId ? (pros.find((x) => x._id.equals(d.professionalId!))?.displayName ?? '') : null,
        client: c ? { id: c.id as string, name: `${c.firstName} ${c.lastName}`.trim(), phone: c.phone ?? null, email: c.email ?? null } : null,
        dateFrom: d.dateFrom,
        dateTo: d.dateTo,
        timeOfDay: d.timeOfDay,
        notes: d.notes ?? '',
        status: d.status,
        source: d.source,
        appointmentId: d.appointmentId?.toString() ?? null,
        notifiedAt: d.notifiedAt,
        createdAt: (d as unknown as { createdAt: Date }).createdAt,
      };
    });
  }
}
