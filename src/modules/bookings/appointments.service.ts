import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model, QueryFilter } from 'mongoose';
import { AuditService } from '../../core/audit/audit.service.js';
import type { PermissionKey } from '../../core/authorization/permissions.catalog.js';
import { currentScope } from '../../core/authorization/scope.js';
import { Errors } from '../../core/common/errors.js';
import { utcToZoned } from '../../core/scheduling/zoned-time.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { Client } from '../clients/schemas/client.schema.js';
import { Branch } from '../organization/schemas/branch.schema.js';
import { Professional } from '../professionals/schemas/professional.schema.js';
import { blockedRange } from './availability.engine.js';
import { AvailabilityService } from './availability.service.js';
import { BookingMailerService } from './booking-mailer.service.js';
import { AutomationsService } from './automations/automations.service.js';
import { discountFor, type AppliedPromotion } from '../promotions/promotions.service.js';
import type { CreateAppointmentDto, ListAppointmentsQuery } from './dto/booking.dto.js';
import {
  ALLOWED_TRANSITIONS,
  Appointment,
  type AppointmentDocument,
  type AppointmentStatus,
  type DepositMethod,
} from './schemas/appointment.schema.js';
import { Counter } from './schemas/counter.schema.js';
import { Resource } from '../resources/resource.schema.js';

/** La primera cita de cada negocio es la #1001. */
const FIRST_NUMBER = 1000;

export interface AppointmentView {
  id: string;
  number: number;
  branchId: string;
  professionalId: string;
  serviceId: string;
  serviceName: string;
  status: AppointmentStatus;
  startsAt: Date;
  endsAt: Date;
  price: number;
  durationMinutes: number;
  channel: string;
  notes?: string;
  rescheduleCount: number;
  listPrice: number | null;
  promotionCode: string | null;
  resourceId: string | null;
  deposit: { amount: number; status: 'pending_review' | 'approved' | 'rejected'; method: DepositMethod; reference?: string; submittedAt: Date; rejectReason?: string } | null;
  history: Array<{ status: AppointmentStatus; at: Date; note?: string }>;
  client: { id: string; firstName: string; lastName: string; phone?: string } | null;
}

@Injectable()
export class AppointmentsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Appointment.name) private readonly appointments: Model<Appointment>,
    @InjectModel(Counter.name) private readonly counters: Model<Counter>,
    @InjectModel(Professional.name) private readonly professionals: Model<Professional>,
    @InjectModel(Client.name) private readonly clients: Model<Client>,
    @InjectModel(Branch.name) private readonly branches: Model<Branch>,
    @InjectModel(Resource.name) private readonly resources: Model<Resource>,
    private readonly availability: AvailabilityService,
    private readonly mailer: BookingMailerService,
    private readonly automations: AutomationsService,
    private readonly audit: AuditService,
  ) {}

  /* ---------- Lectura ---------- */

  async list(query: ListAppointmentsQuery): Promise<AppointmentView[]> {
    const filter = await this.scopeFilter('booking.read');
    const docs = await this.appointments
      .find({
        ...filter,
        branchId: query.branchId,
        startsAt: { $lt: query.to },
        endsAt: { $gt: query.from },
        ...(query.professionalId && { professionalId: query.professionalId }),
      })
      .sort({ startsAt: 1 })
      .exec();
    return this.toViews(docs);
  }

  async get(id: string): Promise<AppointmentView> {
    const [view] = await this.toViews([await this.findScoped(id, 'booking.read')]);
    return view!;
  }

  /* ---------- Crear ---------- */

  /**
   * Agenda una cita desde el panel (el equipo no está sujeto a la anticipación
   * mínima ni a la ventana de reserva). Dentro de una transacción: se bloquea
   * al profesional, se vuelve a verificar el horario y se asigna el número.
   */
  async create(dto: CreateAppointmentDto): Promise<AppointmentView> {
    await this.assertCanBookFor(dto.professionalId, 'booking.create');
    if (!(await this.clients.exists({ _id: dto.clientId }))) throw Errors.badRequest('INVALID_CLIENT', 'Cliente inválido');

    const userId = TenantContext.getActor()?.userId;
    const created = await this.connection.transaction(async (session) => {
      const { service, terms, resourceId } = await this.reserveSlot(session, {
        branchId: dto.branchId,
        serviceId: dto.serviceId,
        professionalId: dto.professionalId,
        startsAt: dto.startsAt,
      });
      const number = await this.nextNumber(session);
      const block = blockedRange(dto.startsAt, terms.durationMinutes, service.bufferBeforeMinutes, service.bufferAfterMinutes);
      const [doc] = await this.appointments.create(
        [
          {
            number,
            branchId: dto.branchId,
            professionalId: dto.professionalId,
            serviceId: dto.serviceId,
            clientId: dto.clientId,
            startsAt: dto.startsAt,
            endsAt: new Date(dto.startsAt.getTime() + terms.durationMinutes * 60_000),
            blockedFrom: block.start,
            blockedUntil: block.end,
            resourceId,
            status: 'confirmed',
            serviceName: service.name,
            price: terms.price,
            durationMinutes: terms.durationMinutes,
            channel: 'backoffice',
            notes: dto.notes,
            createdBy: userId,
            history: [{ status: 'confirmed', at: new Date(), byUserId: userId, note: 'Agendada desde el panel' }],
          },
        ],
        { session },
      );
      return doc!;
    });

    await this.audit.log({ action: 'appointment.created', entityType: 'Appointment', entityId: created.id as string });
    await this.mailer.notify('confirmed', created.id as string);
    return this.get(created.id as string);
  }

  /**
   * Reserva desde la página pública: aplica anticipación mínima y ventana de
   * reserva, y queda pendiente si el negocio aprueba manualmente.
   */
  async createOnline(input: {
    branchId: string;
    serviceId: string;
    professionalId: string;
    clientId: string;
    startsAt: Date;
    status: 'pending' | 'confirmed';
    notes?: string;
    promotion?: AppliedPromotion;
    deposit?: { type: 'percent' | 'fixed'; value: number; proofKey: string; method: DepositMethod; reference?: string };
  }): Promise<AppointmentDocument> {
    const created = await this.connection.transaction(async (session) => {
      const { service, terms, resourceId } = await this.reserveSlot(session, input, true);
      const number = await this.nextNumber(session);
      const block = blockedRange(input.startsAt, terms.durationMinutes, service.bufferBeforeMinutes, service.bufferAfterMinutes);
      const price = terms.price - (input.promotion ? discountFor(input.promotion, terms.price) : 0);
      // Adelanto sobre el precio final (con cupón); queda por validar.
      const depositAmount =
        input.deposit && price > 0
          ? input.deposit.type === 'percent'
            ? Math.max(1, Math.round((price * input.deposit.value) / 100))
            : Math.min(input.deposit.value, price)
          : 0;
      const status = depositAmount ? 'pending' : input.status;
      const [doc] = await this.appointments.create(
        [
          {
            number,
            branchId: input.branchId,
            professionalId: input.professionalId,
            serviceId: input.serviceId,
            clientId: input.clientId,
            ...(depositAmount && {
              deposit: {
                amount: depositAmount,
                status: 'pending_review',
                proofKey: input.deposit!.proofKey,
                method: input.deposit!.method,
                reference: input.deposit!.reference,
                submittedAt: new Date(),
              },
            }),
            startsAt: input.startsAt,
            endsAt: new Date(input.startsAt.getTime() + terms.durationMinutes * 60_000),
            blockedFrom: block.start,
            blockedUntil: block.end,
            resourceId,
            status,
            serviceName: service.name,
            price,
            ...(input.promotion && { listPrice: terms.price, promotionId: input.promotion.id, promotionCode: input.promotion.code }),
            durationMinutes: terms.durationMinutes,
            channel: 'online',
            notes: input.notes,
            history: [{ status, at: new Date(), note: depositAmount ? 'Reservada online · adelanto por validar' : 'Reservada en la página online' }],
          },
        ],
        { session },
      );
      return doc!;
    });
    await this.audit.log({
      action: 'appointment.created',
      entityType: 'Appointment',
      entityId: created.id as string,
      metadata: { channel: 'online' },
    });
    await this.mailer.notify(created.status === 'pending' ? 'pending' : 'confirmed', created.id as string);
    return created;
  }

  /** El cliente cancela desde su enlace. */
  async cancelByClient(id: string, reason?: string): Promise<AppointmentDocument> {
    const appt = await this.appointments.findById(id).exec();
    if (!appt) throw Errors.notFound('Cita');
    if (!['pending', 'confirmed'].includes(appt.status) || appt.startsAt.getTime() <= Date.now()) {
      throw Errors.badRequest('NOT_CANCELLABLE', 'Esta cita ya no se puede cancelar');
    }
    appt.status = 'cancelled';
    appt.history.push({ status: 'cancelled', at: new Date(), note: `Cancelada por el cliente${reason ? `: ${reason}` : ''}` });
    await appt.save();
    await this.audit.log({ action: 'appointment.cancelled', entityType: 'Appointment', entityId: id, metadata: { by: 'client' } });
    await this.mailer.notify('cancelled', id);
    return appt;
  }

  /** El cliente cambia el horario desde su enlace (mismo servicio y profesional). */
  async rescheduleByClient(id: string, startsAt: Date, maxReschedules: number | null): Promise<AppointmentDocument> {
    const appt = await this.appointments.findById(id).exec();
    if (!appt) throw Errors.notFound('Cita');
    if (!['pending', 'confirmed'].includes(appt.status) || appt.startsAt.getTime() <= Date.now()) {
      throw Errors.badRequest('NOT_RESCHEDULABLE', 'Esta cita ya no se puede cambiar');
    }
    if (maxReschedules != null && appt.rescheduleCount >= maxReschedules) {
      throw Errors.badRequest('RESCHEDULE_LIMIT', 'Ya cambiaste esta cita el máximo de veces permitido. Comunícate con el negocio.');
    }
    await this.move(appt, { startsAt }, true);
    await this.audit.log({ action: 'appointment.rescheduled', entityType: 'Appointment', entityId: id, metadata: { by: 'client' } });
    await this.mailer.notify('rescheduled', id);
    return appt;
  }

  /* ---------- Cambios ---------- */

  async changeStatus(id: string, status: AppointmentStatus, note?: string, by: 'client' | 'business' = 'business'): Promise<AppointmentView> {
    const appt = await this.findScoped(id, status === 'cancelled' ? 'booking.cancel' : 'booking.update');
    if (appt.status === status) return this.get(id);
    if (!ALLOWED_TRANSITIONS[appt.status].includes(status)) {
      throw Errors.badRequest('INVALID_TRANSITION', `No se puede pasar de "${appt.status}" a "${status}"`, {
        from: appt.status,
        to: status,
      });
    }
    const from = appt.status;
    appt.status = status;
    appt.history.push({ status, at: new Date(), byUserId: TenantContext.getActor()?.userId as never, note });
    await appt.save();
    await this.audit.log({ action: `appointment.${status}`, entityType: 'Appointment', entityId: id });
    if (from === 'pending' && status === 'confirmed') await this.mailer.notify('approved', id);
    if (status === 'cancelled') await this.mailer.notify(by === 'client' ? 'cancelled' : 'cancelled_by_business', id);
    if (status === 'no_show') await this.automations.dispatch('noShow', { appointmentId: id }).catch(() => 0);
    return this.get(id);
  }

  /**
   * Lleva la cita a "completada" recorriendo el flujo (p. ej. al cobrar):
   * confirmada → en el local → completada.
   */
  async complete(id: string): Promise<AppointmentView> {
    const path: Partial<Record<AppointmentStatus, AppointmentStatus>> = {
      confirmed: 'checked_in',
      checked_in: 'completed',
      in_progress: 'completed',
    };
    let current = (await this.findScoped(id, 'booking.update')).status;
    while (path[current]) {
      current = path[current]!;
      await this.changeStatus(id, current, current === 'completed' ? 'Completada al cobrar' : undefined);
    }
    return this.get(id);
  }

  /** Nota y/o cliente de la cita. */
  async update(id: string, dto: { notes?: string; clientId?: string }): Promise<AppointmentView> {
    const appt = await this.findScoped(id, 'booking.update');
    if (dto.notes !== undefined) appt.notes = dto.notes;
    if (dto.clientId && dto.clientId !== appt.clientId.toString()) {
      const client = await this.clients.findById(dto.clientId).exec();
      if (!client) throw Errors.badRequest('INVALID_CLIENT', 'Cliente inválido');
      appt.clientId = client._id;
      appt.history.push({
        status: appt.status,
        at: new Date(),
        byUserId: TenantContext.getActor()?.userId as never,
        note: `Cliente cambiado a ${`${client.firstName} ${client.lastName}`.trim()}`,
      });
    }
    await appt.save();
    return this.get(id);
  }

  /**
   * Cambia horario, profesional y/o servicio. Se vuelve a verificar la
   * disponibilidad y se recalculan precio y duración si cambia el servicio
   * o el profesional.
   */
  async reschedule(
    id: string,
    change: { startsAt: Date; professionalId?: string; serviceId?: string },
  ): Promise<AppointmentView> {
    const appt = await this.findScoped(id, 'booking.update');
    if (!['pending', 'confirmed'].includes(appt.status)) {
      throw Errors.badRequest('NOT_RESCHEDULABLE', 'Solo se pueden modificar citas pendientes o confirmadas');
    }
    const targetPro = change.professionalId ?? appt.professionalId.toString();
    if (targetPro !== appt.professionalId.toString()) await this.assertCanBookFor(targetPro, 'booking.update');
    await this.move(appt, change, false);
    await this.audit.log({ action: 'appointment.rescheduled', entityType: 'Appointment', entityId: id });
    await this.mailer.notify('rescheduled', id);
    return this.get(id);
  }

  /** Próximas citas, historial y resumen de un cliente (para gestionar su cita). */
  async forClient(clientId: string) {
    const filter = await this.scopeFilter('booking.read');
    const docs = await this.appointments.find({ ...filter, clientId }).sort({ startsAt: -1 }).limit(200).exec();
    const now = Date.now();
    const isUpcoming = (d: AppointmentDocument) => d.startsAt.getTime() >= now && ['pending', 'confirmed'].includes(d.status);
    const completed = docs.filter((d) => d.status === 'completed');
    return {
      stats: {
        total: docs.filter((d) => d.status !== 'cancelled').length,
        completed: completed.length,
        noShows: docs.filter((d) => d.status === 'no_show').length,
        cancelled: docs.filter((d) => d.status === 'cancelled').length,
        spent: completed.reduce((acc, d) => acc + d.price, 0),
        lastVisit: completed[0]?.startsAt ?? null,
      },
      upcoming: await this.toViews(docs.filter(isUpcoming).reverse().slice(0, 10)),
      past: await this.toViews(docs.filter((d) => !isUpcoming(d)).slice(0, 20)),
    };
  }

  /* ---------- Internos ---------- */

  /** Cambia horario, profesional y/o servicio verificando de nuevo la disponibilidad. */
  private async move(
    appt: AppointmentDocument,
    change: { startsAt: Date; professionalId?: string; serviceId?: string },
    applyRules: boolean,
  ): Promise<void> {
    const id = appt.id as string;
    const targetPro = change.professionalId ?? appt.professionalId.toString();
    const targetService = change.serviceId ?? appt.serviceId.toString();

    const before = {
      startsAt: appt.startsAt,
      professionalId: appt.professionalId.toString(),
      serviceId: appt.serviceId.toString(),
      serviceName: appt.serviceName,
    };
    const timeChanged = change.startsAt.getTime() !== appt.startsAt.getTime();

    await this.connection.transaction(async (session) => {
      const { service, terms, timezone, resourceId } = await this.reserveSlot(session, {
        branchId: appt.branchId.toString(),
        serviceId: targetService,
        professionalId: targetPro,
        startsAt: change.startsAt,
        excludeAppointmentId: id,
      }, applyRules);
      const block = blockedRange(change.startsAt, terms.durationMinutes, service.bufferBeforeMinutes, service.bufferAfterMinutes);
      const repriced = targetPro !== before.professionalId || targetService !== before.serviceId;
      appt.set({
        professionalId: targetPro,
        startsAt: change.startsAt,
        endsAt: new Date(change.startsAt.getTime() + terms.durationMinutes * 60_000),
        blockedFrom: block.start,
        blockedUntil: block.end,
        resourceId,
        ...(timeChanged && { rescheduleCount: appt.rescheduleCount + 1 }),
        ...(repriced && {
          serviceId: targetService,
          serviceName: service.name,
          price: terms.price,
          durationMinutes: terms.durationMinutes,
        }),
      });

      const notes: string[] = [];
      const fmt = new Intl.DateTimeFormat('es-PE', {
        timeZone: timezone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
      if (timeChanged) notes.push(`Movida de ${fmt.format(before.startsAt)} a ${fmt.format(change.startsAt)}`);
      if (targetPro !== before.professionalId) {
        const pros = await this.professionals
          .find({ _id: { $in: [before.professionalId, targetPro] } })
          .select('displayName')
          .session(session)
          .exec();
        const name = (pid: string) => pros.find((p) => p.id === pid)?.displayName ?? 'otro profesional';
        notes.push(`Profesional: ${name(before.professionalId)} → ${name(targetPro)}`);
      }
      if (targetService !== before.serviceId) notes.push(`Servicio: ${before.serviceName} → ${service.name}`);
      if (notes.length) {
        appt.history.push({
          status: appt.status,
          at: new Date(),
          byUserId: TenantContext.getActor()?.userId as never,
          note: notes.join(' · '),
        });
      }
      await appt.save({ session });
    });
  }


  /**
   * Bloquea al profesional (el $inc hace que dos transacciones simultáneas
   * choquen y una se reintente) y verifica que el horario siga libre.
   */
  private async reserveSlot(
    session: ClientSession,
    req: { branchId: string; serviceId: string; professionalId: string; startsAt: Date; excludeAppointmentId?: string },
    applyRules = false,
  ) {
    await this.professionals.updateOne({ _id: req.professionalId }, { $inc: { bookingVersion: 1 } }, { session }).exec();

    const branch = await this.branches.findById(req.branchId).select('timezone').session(session).exec();
    if (!branch) throw Errors.notFound('Sucursal');
    const date = utcToZoned(req.startsAt, branch.timezone).date;
    const result = await this.availability.compute({
      branchId: req.branchId,
      serviceId: req.serviceId,
      professionalId: req.professionalId,
      from: date,
      to: date,
      applyRules,
      excludeAppointmentId: req.excludeAppointmentId,
      session,
    });
    const pro = result.professionals[0]!;
    const slot = pro.days[0]!.slots.find((s) => s.start.getTime() === req.startsAt.getTime());
    if (!slot) {
      throw Errors.conflict('SLOT_UNAVAILABLE', 'Ese horario no está disponible (fuera del horario de atención o con ausencia)');
    }
    if (!slot.available) throw Errors.conflict('SLOT_TAKEN', 'Ese horario ya está ocupado');
    // Bloquea el recurso: dos reservas simultáneas del mismo recurso chocan y una se reintenta.
    if (slot.resourceId) {
      await this.resources.updateOne({ _id: slot.resourceId }, { $inc: { bookingVersion: 1 } }, { session }).exec();
    }
    return {
      resourceId: slot.resourceId ?? null,
      service: result.service,
      terms: { price: pro.price, durationMinutes: pro.durationMinutes },
      timezone: result.timezone,
    };
  }

  private async nextNumber(session: ClientSession): Promise<number> {
    const counter = await this.counters
      .findOneAndUpdate({ key: 'appointment' }, { $inc: { value: 1 } }, { upsert: true, new: true, session })
      .exec();
    return FIRST_NUMBER + counter!.value;
  }

  /** Filtro de citas según el alcance del permiso (propio, sede, negocio). */
  private async scopeFilter(permission: PermissionKey): Promise<QueryFilter<Appointment>> {
    const access = TenantContext.getAccess();
    const scope = currentScope(permission);
    if (!access || !scope) throw Errors.forbidden();
    if (scope === 'organization') return {};
    if (scope === 'branch') return access.branchIds.length ? { branchId: { $in: access.branchIds } } : {};
    const mine = await this.professionals.find({ membershipId: access.membershipId }).select('_id').exec();
    return { professionalId: { $in: mine.map((p) => p._id) } };
  }

  private async findScoped(id: string, permission: PermissionKey): Promise<AppointmentDocument> {
    const appt = await this.appointments.findOne({ _id: id, ...(await this.scopeFilter(permission)) }).exec();
    if (!appt) throw Errors.notFound('Cita');
    return appt;
  }

  /** Alcance "propio": solo puede agendar o mover citas a su nombre. */
  private async assertCanBookFor(professionalId: string, permission: PermissionKey): Promise<void> {
    const scope = currentScope(permission);
    if (!scope) throw Errors.forbidden();
    if (scope === 'own') {
      const p = await this.professionals.findById(professionalId).select('membershipId').exec();
      if (!p || p.membershipId?.toString() !== TenantContext.getAccess()?.membershipId) {
        throw Errors.forbidden('Solo puedes agendar en tu propia agenda');
      }
    }
  }

  private async toViews(docs: AppointmentDocument[]): Promise<AppointmentView[]> {
    const clients = await this.clients
      .find({ _id: { $in: [...new Set(docs.map((d) => d.clientId.toString()))] } })
      .select('firstName lastName phone')
      .exec();
    const byId = new Map(clients.map((c) => [c.id as string, c]));
    return docs.map((d) => {
      const c = byId.get(d.clientId.toString());
      return {
        id: d.id as string,
        number: d.number,
        branchId: d.branchId.toString(),
        professionalId: d.professionalId.toString(),
        serviceId: d.serviceId.toString(),
        serviceName: d.serviceName,
        status: d.status,
        startsAt: d.startsAt,
        endsAt: d.endsAt,
        price: d.price,
        durationMinutes: d.durationMinutes,
        channel: d.channel,
        notes: d.notes,
        rescheduleCount: d.rescheduleCount,
        listPrice: d.listPrice ?? null,
        promotionCode: d.promotionCode ?? null,
        resourceId: d.resourceId?.toString() ?? null,
        deposit: d.deposit
          ? { amount: d.deposit.amount, status: d.deposit.status, method: d.deposit.method, reference: d.deposit.reference, submittedAt: d.deposit.submittedAt, rejectReason: d.deposit.rejectReason }
          : null,
        history: d.history.map((h) => ({ status: h.status, at: h.at, note: h.note })),
        client: c ? { id: c.id as string, firstName: c.firstName, lastName: c.lastName, phone: c.phone } : null,
      };
    });
  }
}
