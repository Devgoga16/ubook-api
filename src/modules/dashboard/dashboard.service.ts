import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter, Types } from 'mongoose';
import { currentScope } from '../../core/authorization/scope.js';
import { Errors } from '../../core/common/errors.js';
import { addDays, utcToZoned, zonedToUtc } from '../../core/scheduling/zoned-time.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { workingWindows } from '../bookings/availability.engine.js';
import { Appointment, type AppointmentDocument, type AppointmentStatus } from '../bookings/schemas/appointment.schema.js';
import { Client } from '../clients/schemas/client.schema.js';
import { BranchException } from '../organization/schemas/branch-exception.schema.js';
import { Branch } from '../organization/schemas/branch.schema.js';
import { EntitlementsService } from '../platform/entitlements.service.js';
import { CashClose, Payment } from '../payments/schemas/payment.schemas.js';
import { Professional, type ProfessionalDocument } from '../professionals/schemas/professional.schema.js';
import { TimeOff } from '../professionals/schemas/time-off.schema.js';

/** Citas que cuentan como agenda ocupada (no canceladas ni faltas). */
const ACTIVE: AppointmentStatus[] = ['pending', 'confirmed', 'checked_in', 'in_progress', 'completed'];
const UPCOMING: AppointmentStatus[] = ['pending', 'confirmed', 'checked_in', 'in_progress'];

const overlapMinutes = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / 60_000;

/**
 * Resumen del día para la pantalla de inicio. Respeta el alcance de cada
 * persona: un profesional ve solo lo suyo; recepción, sus sedes.
 */
@Injectable()
export class DashboardService {
  constructor(
    @InjectModel(Appointment.name) private readonly appointments: Model<Appointment>,
    @InjectModel(Professional.name) private readonly professionals: Model<Professional>,
    @InjectModel(Branch.name) private readonly branches: Model<Branch>,
    @InjectModel(BranchException.name) private readonly exceptions: Model<BranchException>,
    @InjectModel(TimeOff.name) private readonly timeOff: Model<TimeOff>,
    @InjectModel(Client.name) private readonly clients: Model<Client>,
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
    @InjectModel(CashClose.name) private readonly closes: Model<CashClose>,
    private readonly entitlements: EntitlementsService,
  ) {}

  async summary(branchId: string) {
    const access = TenantContext.getAccess();
    const scope = currentScope('booking.read');
    if (!access || !scope) throw Errors.forbidden();
    if (scope !== 'organization' && access.branchIds.length && !access.branchIds.includes(branchId)) throw Errors.forbidden();

    const branch = await this.branches.findOne({ _id: branchId, isActive: true }).exec();
    if (!branch) throw Errors.notFound('Sucursal');
    const tz = branch.timezone;
    const now = new Date();
    const today = utcToZoned(now, tz).date;
    const dayStart = zonedToUtc(today, 0, tz);
    const dayEnd = zonedToUtc(addDays(today, 1), 0, tz);
    const weekEnd = zonedToUtc(addDays(today, 8), 0, tz);
    const lastWeekStart = zonedToUtc(addDays(today, -7), 0, tz);
    const lastWeekEnd = zonedToUtc(addDays(today, -6), 0, tz);

    // Alcance "propio": solo sus perfiles de profesional.
    const mine =
      scope === 'own' ? (await this.professionals.find({ membershipId: access.membershipId }).select('_id').exec()).map((p) => p._id) : null;
    const scoped: QueryFilter<Appointment> = { branchId: branch._id, ...(mine && { professionalId: { $in: mine } }) };

    const [todays, lastWeek, upcoming, pros, exception, offs] = await Promise.all([
      this.appointments.find({ ...scoped, startsAt: { $gte: dayStart, $lt: dayEnd } }).exec(),
      this.appointments.countDocuments({ ...scoped, startsAt: { $gte: lastWeekStart, $lt: lastWeekEnd }, status: { $in: [...ACTIVE, 'no_show' as AppointmentStatus] } }),
      this.appointments
        .find({ ...scoped, startsAt: { $gte: new Date(now.getTime() - 3 * 3_600_000), $lt: weekEnd }, status: { $in: UPCOMING } })
        .sort({ startsAt: 1 })
        .limit(80)
        .exec(),
      this.professionals.find({ isActive: true, branchIds: branch._id, ...(mine && { _id: { $in: mine } }) }).sort({ displayName: 1 }).exec(),
      this.exceptions.findOne({ branchId: branch._id, date: today }).exec(),
      this.timeOff.find({ status: 'approved', startsAt: { $lt: dayEnd }, endsAt: { $gt: dayStart } }).exec(),
    ]);

    /* ---------- Ocupación por profesional ---------- */
    const occupancy = pros.map((p) => {
      const days = p.schedules.find((s) => s.branchId.equals(branch._id))?.days ?? [];
      const windows = workingWindows({ date: today, branchHours: branch.openingHours, exception: exception ?? null, professionalDays: days });
      let capacity = 0;
      for (const w of windows) {
        const ws = zonedToUtc(today, w.start, tz).getTime();
        const we = zonedToUtc(today, w.end, tz).getTime();
        const off = offs.filter((t) => t.professionalId.equals(p._id)).reduce((acc, t) => acc + overlapMinutes(ws, we, t.startsAt.getTime(), t.endsAt.getTime()), 0);
        capacity += (we - ws) / 60_000 - off;
      }
      const own = todays.filter((a) => a.professionalId.equals(p._id) && ACTIVE.includes(a.status));
      const booked = own.reduce((acc, a) => acc + a.durationMinutes, 0);
      return {
        professionalId: p.id as string,
        displayName: p.displayName,
        color: p.color,
        appointments: own.length,
        bookedMinutes: booked,
        capacityMinutes: Math.max(0, Math.round(capacity)),
        percent: capacity > 0 ? Math.min(100, Math.round((booked / capacity) * 100)) : null,
      };
    });
    const capacity = occupancy.reduce((a, o) => a + o.capacityMinutes, 0);
    const booked = occupancy.reduce((a, o) => a + o.bookedMinutes, 0);

    const active = todays.filter((a) => ACTIVE.includes(a.status));
    const noShows = todays.filter((a) => a.status === 'no_show').length;
    const features = (await this.entitlements.get(TenantContext.requireOrganizationId())).features;
    const canSeeMoney = !!currentScope('payment.read') && features.manual_payments === true;

    /* ---------- Ingresos de hoy ---------- */
    let revenue: { collected: number; sales: number; tips: number; count: number } | null = null;
    if (canSeeMoney) {
      const paid = await this.payments
        .find({ branchId: branch._id, localDate: today, status: 'paid', ...(this.paymentScope(mine)) })
        .exec();
      revenue = {
        collected: paid.reduce((a, p) => a + p.amount + p.tip, 0),
        sales: paid.reduce((a, p) => a + p.amount, 0),
        tips: paid.reduce((a, p) => a + p.tip, 0),
        count: paid.length,
      };
    }

    /* ---------- Clientes nuevos ---------- */
    let newClients: { count: number; online: number } | null = null;
    if (currentScope('client.read') && scope !== 'own') {
      const created = await this.clients.find({ createdAt: { $gte: dayStart, $lt: dayEnd } }).select('source').exec();
      newClients = { count: created.length, online: created.filter((c) => c.source === 'Página de reservas').length };
    }

    return {
      date: today,
      timezone: tz,
      branch: { id: branch.id as string, name: branch.name },
      kpis: {
        appointments: { today: active.length, lastWeek, remaining: active.filter((a) => a.startsAt > now && a.status !== 'completed').length },
        revenue,
        occupancy: { percent: capacity > 0 ? Math.min(100, Math.round((booked / capacity) * 100)) : null, bookedMinutes: booked, capacityMinutes: capacity },
        noShows: { count: noShows, percent: todays.length ? Math.round((noShows / todays.length) * 100) : 0 },
        newClients,
      },
      upcoming: await this.upcomingViews(upcoming, pros),
      professionals: occupancy,
      attention: await this.attention({ branchId: branch._id, today, mine, canSeeMoney, scope, pros: pros.length }),
    };
  }

  /* ---------- Internos ---------- */

  private paymentScope(mine: Types.ObjectId[] | null): QueryFilter<Payment> {
    const scope = currentScope('payment.read');
    if (scope === 'own') return { professionalId: { $in: mine ?? [] } };
    return mine ? { professionalId: { $in: mine } } : {};
  }

  private async upcomingViews(docs: AppointmentDocument[], pros: ProfessionalDocument[]) {
    const clients = await this.clients
      .find({ _id: { $in: [...new Set(docs.map((d) => d.clientId.toString()))] } })
      .select('firstName lastName')
      .exec();
    const others = await this.professionals
      .find({ _id: { $in: docs.map((d) => d.professionalId).filter((id) => !pros.some((p) => p._id.equals(id))) } })
      .select('displayName color')
      .exec();
    const all = [...pros, ...others];
    return docs.map((d) => {
      const c = clients.find((x) => x._id.equals(d.clientId));
      const p = all.find((x) => x._id.equals(d.professionalId));
      return {
        id: d.id as string,
        startsAt: d.startsAt,
        endsAt: d.endsAt,
        status: d.status,
        serviceName: d.serviceName,
        channel: d.channel,
        clientName: c ? `${c.firstName} ${c.lastName}`.trim() : 'Cliente',
        professionalName: p?.displayName ?? '',
        professionalColor: p?.color ?? null,
      };
    });
  }

  /** Avisos accionables: reservas por aprobar, cobros pendientes, caja sin cerrar, agenda sin configurar. */
  private async attention(ctx: {
    branchId: Types.ObjectId;
    today: string;
    mine: Types.ObjectId[] | null;
    canSeeMoney: boolean;
    scope: string;
    pros: number;
  }) {
    const items: Array<{ kind: string; title: string; detail: string; appointmentId?: string; count?: number }> = [];
    const proFilter = ctx.mine ? { professionalId: { $in: ctx.mine } } : {};

    const deposits = await this.appointments
      .find({ branchId: ctx.branchId, 'deposit.status': 'pending_review', status: 'pending', ...proFilter })
      .sort({ startsAt: 1 })
      .limit(20)
      .exec();
    if (deposits.length) {
      items.push({
        kind: 'deposit',
        title: deposits.length === 1 ? '1 adelanto por validar' : `${deposits.length} adelantos por validar`,
        detail: 'Revisa la foto del comprobante y confirma la cita.',
        appointmentId: deposits[0]!.id as string,
        count: deposits.length,
      });
    }

    const pending = await this.appointments
      .find({ branchId: ctx.branchId, status: 'pending', 'deposit.status': { $ne: 'pending_review' }, startsAt: { $gt: new Date() }, ...proFilter })
      .sort({ startsAt: 1 })
      .limit(20)
      .exec();
    if (pending.length) {
      items.push({
        kind: 'pending',
        title: pending.length === 1 ? '1 reserva por confirmar' : `${pending.length} reservas por confirmar`,
        detail: 'Llegaron por la página online y esperan tu aprobación.',
        appointmentId: pending[0]!.id as string,
        count: pending.length,
      });
    }

    if (ctx.canSeeMoney && currentScope('payment.create')) {
      // Citas completadas de los últimos 7 días con saldo pendiente.
      const since = new Date(Date.now() - 7 * 86_400_000);
      const done = await this.appointments
        .find({ branchId: ctx.branchId, status: 'completed', startsAt: { $gte: since }, price: { $gt: 0 }, ...proFilter })
        .select('price serviceName clientId startsAt')
        .exec();
      if (done.length) {
        const paid = await this.payments
          .find({ appointmentId: { $in: done.map((d) => d._id) }, status: 'paid' })
          .select('appointmentId amount discount')
          .exec();
        const unpaid = done
          .map((d) => ({ d, balance: d.price - paid.filter((p) => p.appointmentId.equals(d._id)).reduce((a, p) => a + p.amount + p.discount, 0) }))
          .filter((x) => x.balance > 0)
          .sort((a, b) => b.d.startsAt.getTime() - a.d.startsAt.getTime());
        if (unpaid.length) {
          const first = unpaid[0]!;
          const client = await this.clients.findById(first.d.clientId).select('firstName lastName').exec();
          items.push({
            kind: 'unpaid',
            title: unpaid.length === 1 ? `Cobro pendiente · ${client ? `${client.firstName} ${client.lastName}`.trim() : 'Cliente'}` : `${unpaid.length} citas completadas sin cobrar`,
            detail: unpaid.length === 1 ? `${first.d.serviceName} · S/ ${(first.balance / 100).toFixed(2)}` : 'De los últimos 7 días.',
            appointmentId: first.d.id as string,
            count: unpaid.length,
          });
        }
      }

      // Caja de ayer con cobros y sin cerrar.
      const yesterday = addDays(ctx.today, -1);
      if (ctx.scope !== 'own' && !(await this.closes.exists({ branchId: ctx.branchId, localDate: yesterday }))) {
        const had = await this.payments.exists({ branchId: ctx.branchId, localDate: yesterday, status: 'paid' });
        if (had) items.push({ kind: 'cash', title: 'La caja de ayer no se cerró', detail: 'Cuenta el efectivo y registra el cierre.' });
      }
    }

    if (ctx.pros === 0 && ctx.scope !== 'own') {
      items.push({ kind: 'setup', title: 'Esta sede no tiene profesionales', detail: 'Agrega quién atiende para poder recibir citas.' });
    }
    return items;
  }
}
