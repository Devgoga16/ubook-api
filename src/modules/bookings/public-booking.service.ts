import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AppError, Errors } from '../../core/common/errors.js';
import { utcToZoned, zonedToUtc } from '../../core/scheduling/zoned-time.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { ServiceCategory } from '../catalog/schemas/service-category.schema.js';
import { Service } from '../catalog/schemas/service.schema.js';
import { normalizePhone } from '../clients/clients.service.js';
import { Client, normalizeSearch, type ClientDocument } from '../clients/schemas/client.schema.js';
import { Branch } from '../organization/schemas/branch.schema.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { Organization, type OrganizationDocument } from '../organization/schemas/organization.schema.js';
import { EntitlementsService } from '../platform/entitlements.service.js';
import { Professional } from '../professionals/schemas/professional.schema.js';
import { AppointmentsService } from './appointments.service.js';
import { AvailabilityService, type AvailabilityResult } from './availability.service.js';
import { BookingLinksService } from './booking-links.service.js';
import type { PublicBookingDto, PublicDaysQuery, PublicSlotsQuery } from './dto/public-booking.dto.js';
import type { PublicWaitlistDto } from './dto/waitlist.dto.js';
import { WaitlistService } from './waitlist.service.js';
import { PromotionsService } from '../promotions/promotions.service.js';
import { LOGO_URL_TTL_SECONDS, StorageService } from '../../core/storage/storage.service.js';
import { Appointment, type AppointmentDocument } from './schemas/appointment.schema.js';

const unavailable = () =>
  new AppError(HttpStatus.NOT_FOUND, 'BOOKING_PAGE_UNAVAILABLE', 'Este negocio no está recibiendo reservas online por ahora');

/** Página pública de reservas: sin sesión, siempre dentro del negocio del slug. */
@Injectable()
export class PublicBookingService {
  constructor(
    @InjectModel(Organization.name) private readonly organizations: Model<Organization>,
    @InjectModel(Branch.name) private readonly branches: Model<Branch>,
    @InjectModel(Service.name) private readonly services: Model<Service>,
    @InjectModel(ServiceCategory.name) private readonly categories: Model<ServiceCategory>,
    @InjectModel(Professional.name) private readonly professionals: Model<Professional>,
    @InjectModel(Client.name) private readonly clients: Model<Client>,
    @InjectModel(Appointment.name) private readonly appointments: Model<Appointment>,
    private readonly entitlements: EntitlementsService,
    private readonly availability: AvailabilityService,
    private readonly appointmentsService: AppointmentsService,
    private readonly links: BookingLinksService,
    private readonly waitlist: WaitlistService,
    private readonly promotions: PromotionsService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
  ) {}

  /* ---------- Página del negocio ---------- */

  info(slug: string) {
    return this.open(slug, async (org) => {
      const [branches, services, categories, pros] = await Promise.all([
        this.branches.find({ isActive: true }).sort({ createdAt: 1 }).exec(),
        this.services.find({ isArchived: false, onlineBooking: true }).sort({ name: 1 }).exec(),
        this.categories.find().sort({ order: 1, name: 1 }).exec(),
        this.professionals.find({ isActive: true }).sort({ displayName: 1 }).exec(),
      ]);
      const branchIds = new Set(branches.map((b) => b.id as string));
      const offered = new Set(services.map((s) => s.id as string));
      const professionals = pros
        .map((p) => ({
          id: p.id as string,
          displayName: p.displayName,
          title: p.title ?? '',
          color: p.color,
          branchIds: p.branchIds.map(String).filter((b) => branchIds.has(b)),
          services: p.services
            .filter((x) => offered.has(x.serviceId.toString()))
            .map((x) => ({ serviceId: x.serviceId.toString(), price: x.price ?? null, durationMinutes: x.durationMinutes ?? null })),
        }))
        .filter((p) => p.branchIds.length > 0 && p.services.length > 0);
      const bookable = new Set(professionals.flatMap((p) => p.services.map((s) => s.serviceId)));
      const visible = services.filter((s) => bookable.has(s.id as string));
      const usedCategories = new Set(visible.map((s) => s.categoryId?.toString()).filter(Boolean));
      const rules = org.toObject().bookingRules;
      const logoUrl = await this.logoUrl(org);

      return {
        name: org.name,
        slug: org.slug,
        logoUrl,
        businessType: org.businessType ?? null,
        rules: {
          minNoticeMinutes: rules.minNoticeMinutes,
          maxAdvanceDays: rules.maxAdvanceDays,
          freeCancellationHours: rules.freeCancellationHours,
          maxReschedules: rules.maxReschedules,
          manualApproval: rules.manualApproval,
        },
        branches: branches.map((b) => ({
          id: b.id as string,
          name: b.name,
          address: b.address ?? '',
          reference: b.reference ?? '',
          mapsUrl: b.mapsUrl ?? '',
          phone: b.phone ?? '',
          timezone: b.timezone,
        })),
        categories: categories.filter((c) => usedCategories.has(c.id as string)).map((c) => ({ id: c.id as string, name: c.name })),
        services: visible.map((s) => ({
          id: s.id as string,
          name: s.name,
          description: s.description ?? '',
          categoryId: s.categoryId?.toString() ?? null,
          durationMinutes: s.durationMinutes,
          price: s.price,
          color: s.color,
          deposit: s.deposit?.enabled && s.deposit.value > 0 ? { type: s.deposit.type, value: s.deposit.value } : null,
        })),
        professionals,
        depositInfo: org.toObject().depositInfo ?? { yape: '', plin: '', bank: '', notes: '' },
      };
    });
  }

  /** Foto del comprobante del adelanto (antes de reservar). */
  uploadDeposit(slug: string, buffer: Buffer) {
    return this.open(slug, async (org) => ({ key: await this.storage.putImage(`deposits/${org.id as string}`, buffer) }));
  }

  /** Horarios libres de un día, por profesional (solo los disponibles). */
  slots(slug: string, q: PublicSlotsQuery) {
    return this.open(slug, async () => {
      await this.assertOnlineService(q.serviceId);
      return this.slotsView(await this.availability.compute({ ...q, from: q.date, to: q.date, applyRules: true }));
    });
  }

  /** Días con horarios libres (para el calendario). */
  days(slug: string, q: PublicDaysQuery) {
    return this.open(slug, async () => {
      await this.assertOnlineService(q.serviceId);
      return this.daysView(await this.availability.compute({ ...q, applyRules: true }));
    });
  }

  /* ---------- Reservar ---------- */

  book(slug: string, dto: PublicBookingDto) {
    return this.open(slug, async (org) => {
      await this.assertOnlineService(dto.serviceId);
      await this.assertMonthlyLimit(org);
      const svc = await this.services.findById(dto.serviceId).select('deposit').exec();
      const depositRule = svc?.deposit?.enabled && svc.deposit.value > 0 ? svc.deposit : null;
      if (depositRule) {
        if (!dto.deposit) throw Errors.badRequest('DEPOSIT_REQUIRED', 'Este servicio pide un adelanto: sube la foto de tu comprobante');
        if (!dto.deposit.proofKey.startsWith(`deposits/${org.id as string}/`)) throw Errors.badRequest('INVALID_PROOF', 'Comprobante inválido. Súbelo de nuevo.');
      }

      const professionalId = dto.professionalId ?? (await this.pickProfessional(dto));
      const client = await this.resolveClient(dto);
      const rules = org.toObject().bookingRules;

      if (rules.maxActiveBookingsPerClient != null) {
        const active = await this.appointments.countDocuments({
          clientId: client._id,
          status: { $in: ['pending', 'confirmed'] },
          startsAt: { $gt: new Date() },
        });
        if (active >= rules.maxActiveBookingsPerClient) {
          throw Errors.conflict('TOO_MANY_BOOKINGS', `Ya tienes ${active} ${active === 1 ? 'cita agendada' : 'citas agendadas'}. Para reservar otra, comunícate con el negocio.`);
        }
      }

      const isNew = !(await this.appointments.exists({ clientId: client._id, status: 'completed' }));
      const pending = rules.manualApproval === 'all' || (rules.manualApproval === 'new_clients' && isNew);
      const branch = await this.branches.findById(dto.branchId).select('timezone').exec();
      const promotion = dto.promoCode
        ? await this.promotions.apply({
            code: dto.promoCode,
            serviceId: dto.serviceId,
            startsAt: dto.startsAt,
            timezone: branch?.timezone ?? org.timezone,
            clientId: client.id as string,
            isNewClient: isNew,
          })
        : undefined;

      const appt = await this.appointmentsService.createOnline({
        branchId: dto.branchId,
        serviceId: dto.serviceId,
        professionalId,
        clientId: client.id as string,
        startsAt: dto.startsAt,
        status: pending ? 'pending' : 'confirmed',
        notes: dto.notes,
        promotion,
        ...(depositRule && dto.deposit && { deposit: { type: depositRule.type, value: depositRule.value, ...dto.deposit } }),
      });
      await this.notifications.notify({
        type: depositRule ? 'deposit_submitted' : pending ? 'booking_pending' : 'booking_created',
        title: depositRule ? 'Adelanto por validar' : pending ? 'Reserva por aprobar' : 'Nueva reserva online',
        body: await this.describe(appt, org),
        ...this.target(appt),
      });
      return { token: this.links.token(appt.id as string), booking: await this.view(appt, org) };
    });
  }

  /** Comprobar un cupón antes de reservar. */
  promo(slug: string, code: string, serviceId: string) {
    return this.open(slug, () => this.promotions.preview(code, serviceId));
  }

  /** Sin horarios que le sirvan: el cliente se anota en la lista de espera. */
  joinWaitlist(slug: string, dto: PublicWaitlistDto) {
    return this.open(slug, async () => {
      await this.assertOnlineService(dto.serviceId);
      const client = await this.resolveClient(dto as unknown as PublicBookingDto);
      await this.waitlist.create({ ...dto, clientId: client.id as string }, 'online');
      const svc = await this.services.findById(dto.serviceId).select('name').exec();
      const range = dto.dateFrom === dto.dateTo ? dayLabel(dto.dateFrom) : `del ${dayLabel(dto.dateFrom)} al ${dayLabel(dto.dateTo)}`;
      await this.notifications.notify({
        type: 'waitlist_joined',
        title: 'Nuevo en lista de espera',
        body: [`${client.firstName} ${client.lastName ?? ''}`.trim(), svc?.name, range].filter(Boolean).join(' · '),
        branchId: dto.branchId,
        professionalId: dto.professionalId ?? null,
      });
      return { ok: true, firstName: client.firstName };
    });
  }

  /* ---------- Gestionar con el enlace ---------- */

  manage(token: string) {
    return this.withBooking(token, (appt, org) => this.view(appt, org));
  }

  cancel(token: string, reason?: string) {
    return this.withBooking(token, async (appt, org) => {
      const cancelled = await this.appointmentsService.cancelByClient(appt.id as string, reason);
      await this.notifications.notify({
        type: 'booking_cancelled',
        title: 'El cliente canceló su cita',
        body: [await this.describe(cancelled, org), reason?.trim() && `Motivo: ${reason.trim()}`].filter(Boolean).join(' · '),
        ...this.target(cancelled),
      });
      return this.view(cancelled, org);
    });
  }

  reschedule(token: string, startsAt: Date) {
    return this.withBooking(token, async (appt, org) => {
      await this.assertPageOpen(org);
      const before = await this.when(appt, org);
      const moved = await this.appointmentsService.rescheduleByClient(appt.id as string, startsAt, org.toObject().bookingRules.maxReschedules);
      await this.notifications.notify({
        type: 'booking_rescheduled',
        title: 'El cliente cambió el horario',
        body: `${await this.describe(moved, org)} (antes: ${before})`,
        ...this.target(moved),
      });
      return this.view(moved, org);
    });
  }

  /** Horarios para reprogramar: mismo servicio, profesional y sede, sin contar la propia cita. */
  manageSlots(token: string, date: string) {
    return this.withBooking(token, async (appt, org) => {
      await this.assertPageOpen(org);
      return this.slotsView(await this.availability.compute(this.sameAs(appt, date, date)));
    });
  }

  manageDays(token: string, from: string, to: string) {
    return this.withBooking(token, async (appt, org) => {
      await this.assertPageOpen(org);
      return this.daysView(await this.availability.compute(this.sameAs(appt, from, to)));
    });
  }

  /* ---------- Internos ---------- */

  private async open<T>(slug: string, fn: (org: OrganizationDocument) => Promise<T>): Promise<T> {
    const org = await this.organizations.findOne({ slug: slug.toLowerCase().trim(), status: 'active' }).exec();
    if (!org) throw unavailable();
    await this.assertPageOpen(org);
    return TenantContext.runForOrganization(org.id as string, () => fn(org));
  }

  private async assertPageOpen(org: OrganizationDocument): Promise<void> {
    const ent = await this.entitlements.get(org.id as string);
    if (ent.readOnly || ent.features.public_booking_page !== true) throw unavailable();
  }

  /** "Ana Ríos · Corte clásico · vie 10 oct, 16:00" para los avisos del equipo. */
  private async describe(appt: AppointmentDocument, org: OrganizationDocument): Promise<string> {
    const [client, svc] = await Promise.all([
      this.clients.findById(appt.clientId).select('firstName lastName').exec(),
      this.services.findById(appt.serviceId).select('name').exec(),
    ]);
    const name = client ? `${client.firstName} ${client.lastName ?? ''}`.trim() : '';
    return [name, svc?.name, await this.when(appt, org)].filter(Boolean).join(' · ');
  }

  private async when(appt: AppointmentDocument, org: OrganizationDocument): Promise<string> {
    const branch = await this.branches.findById(appt.branchId).select('timezone').exec();
    return new Intl.DateTimeFormat('es-PE', {
      timeZone: branch?.timezone ?? org.timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .format(appt.startsAt)
      .replace(/\./g, '');
  }

  private target(appt: AppointmentDocument) {
    return { appointmentId: appt.id as string, branchId: appt.branchId.toString(), professionalId: appt.professionalId.toString() };
  }

  /** Logo firmado, solo si el plan incluye marca propia. */
  private async logoUrl(org: OrganizationDocument): Promise<string | null> {
    if (!org.logoKey) return null;
    const ent = await this.entitlements.get(org.id as string);
    return ent.features.branding === true ? this.storage.url(org.logoKey, LOGO_URL_TTL_SECONDS) : null;
  }

  private async withBooking<T>(token: string, fn: (appt: AppointmentDocument, org: OrganizationDocument) => Promise<T>): Promise<T> {
    const id = this.links.verify(token);
    const appt = id ? await TenantContext.runAsSystem(() => this.appointments.findById(id).exec()) : null;
    if (!appt) throw Errors.notFound('Reserva');
    const org = await this.organizations.findById(appt.organizationId).exec();
    if (!org) throw Errors.notFound('Reserva');
    return TenantContext.runForOrganization(org.id as string, () => fn(appt, org));
  }

  private sameAs(appt: AppointmentDocument, from: string, to: string) {
    return {
      branchId: appt.branchId.toString(),
      serviceId: appt.serviceId.toString(),
      professionalId: appt.professionalId.toString(),
      from,
      to,
      applyRules: true,
      excludeAppointmentId: appt.id as string,
    };
  }

  private async assertOnlineService(serviceId: string): Promise<void> {
    if (!(await this.services.exists({ _id: serviceId, isArchived: false, onlineBooking: true }))) {
      throw Errors.badRequest('SERVICE_NOT_ONLINE', 'Este servicio no se puede reservar online');
    }
  }

  /** Límite de reservas del plan (p. ej. Starter: 150 al mes). */
  private async assertMonthlyLimit(org: OrganizationDocument): Promise<void> {
    const limit = (await this.entitlements.get(org.id as string)).features.max_bookings_per_month;
    if (typeof limit !== 'number') return;
    const today = utcToZoned(new Date(), org.timezone).date;
    const monthStart = zonedToUtc(`${today.slice(0, 8)}01`, 0, org.timezone);
    const count = await this.appointments.countDocuments({ createdAt: { $gte: monthStart } });
    if (count >= limit) {
      throw Errors.conflict('MONTHLY_LIMIT', 'Este negocio no está recibiendo más reservas online este mes. Comunícate con ellos directamente.');
    }
  }

  /** "Cualquiera disponible": quien tiene ese horario libre y más espacio ese día. */
  private async pickProfessional(dto: PublicBookingDto): Promise<string> {
    const branch = await this.branches.findById(dto.branchId).select('timezone').exec();
    if (!branch) throw Errors.notFound('Sucursal');
    const date = utcToZoned(dto.startsAt, branch.timezone).date;
    const result = await this.availability.compute({ branchId: dto.branchId, serviceId: dto.serviceId, from: date, to: date, applyRules: true });
    const candidates = result.professionals
      .map((p) => ({ id: p.professionalId, slots: p.days[0]?.slots ?? [] }))
      .filter((p) => p.slots.some((s) => s.available && s.start.getTime() === dto.startsAt.getTime()))
      .sort((a, b) => b.slots.filter((s) => s.available).length - a.slots.filter((s) => s.available).length);
    if (!candidates[0]) throw Errors.conflict('SLOT_TAKEN', 'Ese horario ya no está disponible. Elige otro.');
    return candidates[0].id;
  }

  /**
   * Mismo celular y mismo nombre = el mismo cliente. Si el celular es de otra
   * persona (p. ej. la mamá), se registra un cliente nuevo con ese número.
   */
  private async resolveClient(dto: PublicBookingDto): Promise<ClientDocument> {
    const phone = normalizePhone(dto.client.phone)!;
    const firstName = normalizeSearch(dto.client.firstName).split(' ')[0];
    const sameNumber = await this.clients.find({ phone }).exec();
    let client = sameNumber.find((c) => normalizeSearch(c.firstName).split(' ')[0] === firstName) ?? null;

    if (!client) {
      client = await this.clients.create({
        firstName: dto.client.firstName,
        lastName: dto.client.lastName,
        phone,
        email: dto.client.email,
        source: 'Página de reservas',
        dataConsentAt: new Date(),
        marketingConsent: dto.marketingConsent === true,
      });
      return client;
    }
    // Completa datos que falten, sin pisar lo que el negocio ya registró.
    if (!client.email && dto.client.email) client.email = dto.client.email;
    if (!client.dataConsentAt) client.dataConsentAt = new Date();
    if (dto.marketingConsent === true) client.marketingConsent = true;
    if (client.isModified()) await client.save();
    return client;
  }

  private slotsView(result: AvailabilityResult) {
    return {
      timezone: result.timezone,
      professionals: result.professionals.map((p) => ({
        professionalId: p.professionalId,
        displayName: p.displayName,
        color: p.color,
        price: p.price,
        durationMinutes: p.durationMinutes,
        slots: (p.days[0]?.slots ?? []).filter((s) => s.available).map((s) => s.start),
      })),
    };
  }

  private daysView(result: AvailabilityResult) {
    const free = new Map<string, number>();
    for (const p of result.professionals) {
      for (const d of p.days) free.set(d.date, (free.get(d.date) ?? 0) + d.slots.filter((s) => s.available).length);
    }
    return { days: [...free].map(([date, count]) => ({ date, free: count })) };
  }

  /** Lo que ve el cliente de su reserva (sin datos de otros). */
  private async view(appt: AppointmentDocument, org: OrganizationDocument) {
    const [branch, pro, client] = await Promise.all([
      this.branches.findById(appt.branchId).exec(),
      this.professionals.findById(appt.professionalId).select('displayName color').exec(),
      this.clients.findById(appt.clientId).select('firstName').exec(),
    ]);
    const rules = org.toObject().bookingRules;
    const open = ['pending', 'confirmed'].includes(appt.status) && appt.startsAt.getTime() > Date.now();
    const hoursLeft = (appt.startsAt.getTime() - Date.now()) / 3_600_000;
    return {
      number: appt.number,
      status: appt.status,
      startsAt: appt.startsAt,
      endsAt: appt.endsAt,
      serviceName: appt.serviceName,
      price: appt.price,
      listPrice: appt.listPrice ?? null,
      promotionCode: appt.promotionCode ?? null,
      deposit: appt.deposit ? { amount: appt.deposit.amount, status: appt.deposit.status, rejectReason: appt.deposit.rejectReason ?? null } : null,
      durationMinutes: appt.durationMinutes,
      professional: { id: appt.professionalId.toString(), displayName: pro?.displayName ?? '', color: pro?.color ?? null },
      branch: {
        id: appt.branchId.toString(),
        name: branch?.name ?? '',
        address: branch?.address ?? '',
        reference: branch?.reference ?? '',
        mapsUrl: branch?.mapsUrl ?? '',
        phone: branch?.phone ?? '',
        timezone: branch?.timezone ?? org.timezone,
      },
      organization: { name: org.name, slug: org.slug, logoUrl: await this.logoUrl(org) },
      clientFirstName: client?.firstName ?? '',
      rescheduleCount: appt.rescheduleCount,
      canCancel: open,
      canReschedule: open && (rules.maxReschedules == null || appt.rescheduleCount < rules.maxReschedules),
      /** Cancelar dentro de este plazo puede tener costo según el negocio. */
      lateCancellation: open && rules.freeCancellationHours != null && hoursLeft < rules.freeCancellationHours,
      freeCancellationHours: rules.freeCancellationHours,
    };
  }
}

/** "2026-10-10" → "10 oct" */
function dayLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat('es-PE', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y!, m! - 1, d!))).replace('.', '');
}
