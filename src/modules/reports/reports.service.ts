import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter, Types } from 'mongoose';
import { currentScope } from '../../core/authorization/scope.js';
import { Errors } from '../../core/common/errors.js';
import { addDays, isValidDate, utcToZoned, weekdayOf, zonedToUtc } from '../../core/scheduling/zoned-time.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { workingWindows } from '../bookings/availability.engine.js';
import { Appointment, type AppointmentStatus } from '../bookings/schemas/appointment.schema.js';
import { Client } from '../clients/schemas/client.schema.js';
import { BranchException } from '../organization/schemas/branch-exception.schema.js';
import { Branch, type BranchDocument } from '../organization/schemas/branch.schema.js';
import { Organization } from '../organization/schemas/organization.schema.js';
import { Payment } from '../payments/schemas/payment.schemas.js';
import { EntitlementsService } from '../platform/entitlements.service.js';
import { Professional } from '../professionals/schemas/professional.schema.js';
import { TimeOff } from '../professionals/schemas/time-off.schema.js';

const MAX_DAYS = 366;
/** Ocupan agenda: todo menos canceladas y faltas. */
const OCCUPYING: AppointmentStatus[] = ['pending', 'confirmed', 'checked_in', 'in_progress', 'completed'];

interface ApptRow {
  _id: Types.ObjectId;
  branchId: Types.ObjectId;
  professionalId: Types.ObjectId;
  clientId: Types.ObjectId;
  serviceName: string;
  status: AppointmentStatus;
  startsAt: Date;
  durationMinutes: number;
  price: number;
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/** Reportes del negocio por periodo, con comparación contra el periodo anterior. */
@Injectable()
export class ReportsService {
  constructor(
    @InjectModel(Appointment.name) private readonly appointments: Model<Appointment>,
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
    @InjectModel(Client.name) private readonly clients: Model<Client>,
    @InjectModel(Professional.name) private readonly professionals: Model<Professional>,
    @InjectModel(Branch.name) private readonly branches: Model<Branch>,
    @InjectModel(BranchException.name) private readonly exceptions: Model<BranchException>,
    @InjectModel(TimeOff.name) private readonly timeOff: Model<TimeOff>,
    @InjectModel(Organization.name) private readonly organizations: Model<Organization>,
    private readonly entitlements: EntitlementsService,
  ) {}

  async overview(q: { from: string; to: string; branchId?: string }) {
    const { from, to } = this.assertRange(q.from, q.to);
    const orgId = TenantContext.requireOrganizationId();
    const features = (await this.entitlements.get(orgId)).features;
    const advanced = features.advanced_reports === true;
    const org = await this.organizations.findById(orgId).select('timezone').exec();
    const tz = org?.timezone ?? 'America/Lima';
    const branches = await this.allowedBranches(q.branchId);
    const branchIds = branches.map((b) => b._id);

    const days = this.daysBetween(from, to);
    const prevTo = addDays(from, -1);
    const prevFrom = addDays(prevTo, -(days.length - 1));

    const [current, previous] = await Promise.all([this.loadAppointments(branchIds, from, to, tz), this.loadAppointments(branchIds, prevFrom, prevTo, tz)]);
    const [capacityNow, capacityPrev] = await Promise.all([this.capacity(branches, from, to, tz), this.capacity(branches, prevFrom, prevTo, tz)]);
    const money = features.manual_payments === true;
    const [collected, collectedPrev] = money
      ? await Promise.all([this.collected(branchIds, from, to), this.collected(branchIds, prevFrom, prevTo)])
      : [null, null];

    const summary = (rows: ApptRow[], cap: { total: number }) => {
      const completed = rows.filter((r) => r.status === 'completed');
      const noShows = rows.filter((r) => r.status === 'no_show').length;
      const booked = rows.filter((r) => OCCUPYING.includes(r.status)).reduce((a, r) => a + r.durationMinutes, 0);
      const sales = completed.reduce((a, r) => a + r.price, 0);
      return {
        sales,
        attended: completed.length,
        averageTicket: completed.length ? Math.round(sales / completed.length) : 0,
        occupancy: pct(booked, cap.total),
        noShowRate: pct(noShows, completed.length + noShows) ?? 0,
        cancelled: rows.filter((r) => r.status === 'cancelled').length,
      };
    };
    const now = summary(current, capacityNow);
    const prev = summary(previous, capacityPrev);

    const [newClients, newClientsPrev] = await Promise.all([this.newClients(from, to, tz), this.newClients(prevFrom, prevTo, tz)]);
    const recurring = advanced ? await this.recurring(current, from, tz) : null;

    /* ---------- Por día ---------- */
    const byDay = days.map((date) => {
      const rows = current.filter((r) => utcToZoned(r.startsAt, tz).date === date);
      const done = rows.filter((r) => r.status === 'completed');
      return { date, sales: done.reduce((a, r) => a + r.price, 0), appointments: rows.filter((r) => OCCUPYING.includes(r.status)).length };
    });

    /* ---------- Por servicio ---------- */
    const services = new Map<string, { appointments: number; sales: number }>();
    for (const r of current.filter((x) => x.status === 'completed')) {
      const s = services.get(r.serviceName) ?? { appointments: 0, sales: 0 };
      s.appointments += 1;
      s.sales += r.price;
      services.set(r.serviceName, s);
    }
    const byService = [...services].map(([serviceName, s]) => ({ serviceName, ...s })).sort((a, b) => b.sales - a.sales);

    return {
      period: { from, to, days: days.length },
      previous: { from: prevFrom, to: prevTo },
      advanced,
      branchReports: features.branch_reports === true,
      kpis: {
        sales: { value: now.sales, previous: prev.sales },
        collected: collected !== null ? { value: collected, previous: collectedPrev } : null,
        attended: { value: now.attended, previous: prev.attended },
        averageTicket: { value: now.averageTicket, previous: prev.averageTicket },
        occupancy: { value: now.occupancy, previous: prev.occupancy },
        noShowRate: { value: now.noShowRate, previous: prev.noShowRate },
        newClients: { value: newClients, previous: newClientsPrev },
        recurringRate: recurring,
        cancelled: { value: now.cancelled, previous: prev.cancelled },
      },
      byDay,
      byService,
      ...(advanced && {
        byProfessional: await this.byProfessional(current, capacityNow.byProfessional, branchIds, from, to),
        heatmap: this.heatmap(current, capacityNow.byHour, tz),
        noShowTrend: await this.noShowTrend(branchIds, to, tz),
        topClients: await this.topClients(current),
      }),
      ...(features.branch_reports === true && !q.branchId && branches.length > 1 && {
        byBranch: branches.map((b) => {
          const rows = current.filter((r) => r.branchId.equals(b._id));
          const s = summary(rows, { total: capacityNow.byBranch.get(b.id as string) ?? 0 });
          return { branchId: b.id as string, name: b.name, sales: s.sales, attended: s.attended, occupancy: s.occupancy, noShowRate: s.noShowRate };
        }),
      }),
    };
  }

  /** Detalle de citas del periodo para exportar a Excel (reportes completos). */
  async exportRows(q: { from: string; to: string; branchId?: string }) {
    const { from, to } = this.assertRange(q.from, q.to);
    const orgId = TenantContext.requireOrganizationId();
    await this.entitlements.assertFeature(orgId, 'advanced_reports');
    const org = await this.organizations.findById(orgId).select('timezone').exec();
    const tz = org?.timezone ?? 'America/Lima';
    const branches = await this.allowedBranches(q.branchId);
    const rows = await this.loadAppointments(branches.map((b) => b._id), from, to, tz);
    const [clients, pros, paid] = await Promise.all([
      this.clients.find({ _id: { $in: [...new Set(rows.map((r) => r.clientId.toString()))] } }).select('firstName lastName phone').exec(),
      this.professionals.find({ _id: { $in: [...new Set(rows.map((r) => r.professionalId.toString()))] } }).select('displayName').exec(),
      this.payments.find({ appointmentId: { $in: rows.map((r) => r._id) }, status: 'paid' }).select('appointmentId amount tip discount methods').exec(),
    ]);
    return rows
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .map((r) => {
        const local = utcToZoned(r.startsAt, tz);
        const c = clients.find((x) => x._id.equals(r.clientId));
        const p = paid.filter((x) => x.appointmentId.equals(r._id));
        return {
          date: local.date,
          time: `${String(Math.floor(local.minutes / 60)).padStart(2, '0')}:${String(local.minutes % 60).padStart(2, '0')}`,
          branch: branches.find((b) => b._id.equals(r.branchId))?.name ?? '',
          professional: pros.find((x) => x._id.equals(r.professionalId))?.displayName ?? '',
          client: c ? `${c.firstName} ${c.lastName}`.trim() : '',
          phone: c?.phone ?? '',
          service: r.serviceName,
          status: r.status,
          price: r.price,
          discount: p.reduce((a, x) => a + x.discount, 0),
          paid: p.reduce((a, x) => a + x.amount, 0),
          tip: p.reduce((a, x) => a + x.tip, 0),
          methods: [...new Set(p.flatMap((x) => x.methods.map((m) => m.method)))].join(' + '),
        };
      });
  }

  /* ---------- Internos ---------- */

  private assertRange(from: string, to: string) {
    if (!isValidDate(from) || !isValidDate(to) || to < from) throw Errors.badRequest('INVALID_RANGE', 'Rango de fechas inválido');
    if (this.daysBetween(from, to).length > MAX_DAYS) throw Errors.badRequest('INVALID_RANGE', 'Máximo un año por consulta');
    return { from, to };
  }

  private daysBetween(from: string, to: string): string[] {
    const out: string[] = [];
    for (let d = from; d <= to && out.length <= MAX_DAYS; d = addDays(d, 1)) out.push(d);
    return out;
  }

  /** Sedes que puede ver: todas, o solo las suyas con alcance de sede. */
  private async allowedBranches(branchId?: string): Promise<BranchDocument[]> {
    const access = TenantContext.getAccess();
    const scope = currentScope('report.view');
    if (!access || !scope) throw Errors.forbidden();
    const filter: QueryFilter<Branch> = {};
    if (scope === 'branch' && access.branchIds.length) filter._id = { $in: access.branchIds };
    const list = await this.branches.find(filter).sort({ createdAt: 1 }).exec();
    if (!branchId) return list;
    const one = list.filter((b) => b.id === branchId);
    if (!one.length) throw Errors.forbidden();
    return one;
  }

  private loadAppointments(branchIds: Types.ObjectId[], from: string, to: string, tz: string): Promise<ApptRow[]> {
    return this.appointments
      .find({ branchId: { $in: branchIds }, startsAt: { $gte: zonedToUtc(from, 0, tz), $lt: zonedToUtc(addDays(to, 1), 0, tz) } })
      .select('branchId professionalId clientId serviceName status startsAt durationMinutes price')
      .lean<ApptRow[]>()
      .exec();
  }

  private async collected(branchIds: Types.ObjectId[], from: string, to: string): Promise<number> {
    const rows = await this.payments.find({ branchId: { $in: branchIds }, status: 'paid', localDate: { $gte: from, $lte: to } }).select('amount tip').exec();
    return rows.reduce((a, p) => a + p.amount + p.tip, 0);
  }

  private newClients(from: string, to: string, tz: string): Promise<number> {
    return this.clients.countDocuments({ createdAt: { $gte: zonedToUtc(from, 0, tz), $lt: zonedToUtc(addDays(to, 1), 0, tz) } }).exec();
  }

  /** % de clientes atendidos en el periodo que ya habían venido antes. */
  private async recurring(rows: ApptRow[], from: string, tz: string) {
    const attended = [...new Set(rows.filter((r) => r.status === 'completed').map((r) => r.clientId.toString()))];
    if (!attended.length) return { value: null, clients: 0, returning: 0 };
    const before = await this.appointments.distinct('clientId', {
      clientId: { $in: attended },
      status: 'completed',
      startsAt: { $lt: zonedToUtc(from, 0, tz) },
    });
    return { value: pct(before.length, attended.length), clients: attended.length, returning: before.length };
  }

  /**
   * Minutos de trabajo disponibles (horario del profesional ∩ horario de la
   * sede, sin feriados ni ausencias), en total, por profesional, por sede y
   * por día de la semana y hora.
   */
  private async capacity(branches: BranchDocument[], from: string, to: string, tz: string) {
    const ids = branches.map((b) => b._id);
    const start = zonedToUtc(from, 0, tz);
    const end = zonedToUtc(addDays(to, 1), 0, tz);
    const [pros, exceptions, offs] = await Promise.all([
      this.professionals.find({ branchIds: { $in: ids } }).select('schedules branchIds isActive').exec(),
      this.exceptions.find({ branchId: { $in: ids }, date: { $gte: from, $lte: to } }).exec(),
      this.timeOff.find({ status: 'approved', startsAt: { $lt: end }, endsAt: { $gt: start } }).exec(),
    ]);
    let total = 0;
    const byProfessional = new Map<string, number>();
    const byBranch = new Map<string, number>();
    const byHour = new Map<string, number>(); // "weekday-hour" → minutos
    for (const date of this.daysBetween(from, to)) {
      const weekday = weekdayOf(date);
      for (const branch of branches) {
        const exception = exceptions.find((e) => e.branchId.equals(branch._id) && e.date === date) ?? null;
        for (const p of pros) {
          if (!p.branchIds.some((b) => b.equals(branch._id))) continue;
          const days = p.schedules.find((s) => s.branchId.equals(branch._id))?.days ?? [];
          const windows = workingWindows({ date, branchHours: branch.openingHours, exception, professionalDays: days });
          const myOffs = offs.filter((t) => t.professionalId.equals(p._id));
          for (const w of windows) {
            // Por hora, descontando ausencias.
            for (let h = Math.floor(w.start / 60); h * 60 < w.end; h++) {
              const s = Math.max(w.start, h * 60);
              const e = Math.min(w.end, (h + 1) * 60);
              const s0 = zonedToUtc(date, s, tz).getTime();
              const e0 = zonedToUtc(date, e, tz).getTime();
              const off = myOffs.reduce((a, t) => a + Math.max(0, Math.min(e0, t.endsAt.getTime()) - Math.max(s0, t.startsAt.getTime())) / 60_000, 0);
              const minutes = Math.max(0, e - s - off);
              if (!minutes) continue;
              total += minutes;
              byProfessional.set(p.id as string, (byProfessional.get(p.id as string) ?? 0) + minutes);
              byBranch.set(branch.id as string, (byBranch.get(branch.id as string) ?? 0) + minutes);
              byHour.set(`${weekday}-${h}`, (byHour.get(`${weekday}-${h}`) ?? 0) + minutes);
            }
          }
        }
      }
    }
    return { total, byProfessional, byBranch, byHour };
  }

  /** Ocupación por día de la semana y hora (minutos reservados / disponibles). */
  private heatmap(rows: ApptRow[], capacity: Map<string, number>, tz: string) {
    const booked = new Map<string, number>();
    for (const r of rows.filter((x) => OCCUPYING.includes(x.status))) {
      const local = utcToZoned(r.startsAt, tz);
      let m = local.minutes;
      const end = Math.min(local.minutes + r.durationMinutes, 1440);
      while (m < end) {
        const h = Math.floor(m / 60);
        const next = Math.min(end, (h + 1) * 60);
        booked.set(`${local.weekday}-${h}`, (booked.get(`${local.weekday}-${h}`) ?? 0) + (next - m));
        m = next;
      }
    }
    const hours = [...capacity.keys()].map((k) => Number(k.split('-')[1]));
    if (!hours.length) return { hours: [], cells: [] };
    const minH = Math.min(...hours);
    const maxH = Math.max(...hours);
    const cells: Array<{ weekday: number; hour: number; percent: number | null }> = [];
    for (let weekday = 1; weekday <= 7; weekday++) {
      for (let hour = minH; hour <= maxH; hour++) {
        const cap = capacity.get(`${weekday}-${hour}`) ?? 0;
        cells.push({ weekday, hour, percent: cap ? Math.min(100, Math.round(((booked.get(`${weekday}-${hour}`) ?? 0) / cap) * 100)) : null });
      }
    }
    return { hours: Array.from({ length: maxH - minH + 1 }, (_, i) => minH + i), cells };
  }

  private async byProfessional(rows: ApptRow[], capacity: Map<string, number>, branchIds: Types.ObjectId[], from: string, to: string) {
    const ids = [...new Set([...rows.map((r) => r.professionalId.toString()), ...capacity.keys()])];
    const [pros, paid] = await Promise.all([
      this.professionals.find({ _id: { $in: ids } }).select('displayName color').exec(),
      this.payments.find({ branchId: { $in: branchIds }, status: 'paid', localDate: { $gte: from, $lte: to } }).select('professionalId commissionAmount tip').exec(),
    ]);
    return pros
      .map((p) => {
        const mine = rows.filter((r) => r.professionalId.equals(p._id));
        const completed = mine.filter((r) => r.status === 'completed');
        const booked = mine.filter((r) => OCCUPYING.includes(r.status)).reduce((a, r) => a + r.durationMinutes, 0);
        const pays = paid.filter((x) => x.professionalId.equals(p._id));
        return {
          professionalId: p.id as string,
          displayName: p.displayName,
          color: p.color,
          attended: completed.length,
          sales: completed.reduce((a, r) => a + r.price, 0),
          occupancy: pct(booked, capacity.get(p.id as string) ?? 0),
          noShows: mine.filter((r) => r.status === 'no_show').length,
          commission: pays.reduce((a, x) => a + x.commissionAmount, 0),
          tips: pays.reduce((a, x) => a + x.tip, 0),
        };
      })
      .filter((p) => p.attended > 0 || p.occupancy !== null)
      .sort((a, b) => b.sales - a.sales);
  }

  /** Tasa de faltas de los últimos 12 meses (hasta el mes de `to`). */
  private async noShowTrend(branchIds: Types.ObjectId[], to: string, tz: string) {
    const months: string[] = [];
    const [y, m] = to.split('-').map(Number) as [number, number];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - 1 - i, 1));
      months.push(d.toISOString().slice(0, 7));
    }
    const rows = await this.appointments
      .find({
        branchId: { $in: branchIds },
        status: { $in: ['completed', 'no_show'] },
        startsAt: { $gte: zonedToUtc(`${months[0]}-01`, 0, tz), $lt: zonedToUtc(addDays(to, 1), 0, tz) },
      })
      .select('status startsAt')
      .lean<Array<{ status: AppointmentStatus; startsAt: Date }>>()
      .exec();
    return months.map((month) => {
      const inMonth = rows.filter((r) => utcToZoned(r.startsAt, tz).date.startsWith(month));
      const noShows = inMonth.filter((r) => r.status === 'no_show').length;
      return { month, total: inMonth.length, noShows, rate: pct(noShows, inMonth.length) };
    });
  }

  private async topClients(rows: ApptRow[]) {
    const byClient = new Map<string, { visits: number; sales: number }>();
    for (const r of rows.filter((x) => x.status === 'completed')) {
      const c = byClient.get(r.clientId.toString()) ?? { visits: 0, sales: 0 };
      c.visits += 1;
      c.sales += r.price;
      byClient.set(r.clientId.toString(), c);
    }
    const top = [...byClient].sort((a, b) => b[1].sales - a[1].sales).slice(0, 8);
    const clients = await this.clients.find({ _id: { $in: top.map(([id]) => id) } }).select('firstName lastName').exec();
    return top.map(([id, c]) => {
      const doc = clients.find((x) => x.id === id);
      return { clientId: id, name: doc ? `${doc.firstName} ${doc.lastName}`.trim() : 'Cliente', ...c };
    });
  }
}
