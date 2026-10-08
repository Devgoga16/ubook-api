import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection, Model, QueryFilter } from 'mongoose';
import { AuditService } from '../../core/audit/audit.service.js';
import { canActOn, currentScope } from '../../core/authorization/scope.js';
import { AppError, Errors } from '../../core/common/errors.js';
import { utcToZoned } from '../../core/scheduling/zoned-time.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { StorageService } from '../../core/storage/storage.service.js';
import { AppointmentsService } from '../bookings/appointments.service.js';
import { Appointment, type AppointmentDocument } from '../bookings/schemas/appointment.schema.js';
import { Counter } from '../bookings/schemas/counter.schema.js';
import { Client } from '../clients/schemas/client.schema.js';
import { Branch } from '../organization/schemas/branch.schema.js';
import { Professional } from '../professionals/schemas/professional.schema.js';
import type { CloseCashDto, CommissionsQuery, CreatePaymentDto, CashMovementDto, ListPaymentsQuery } from './dto/payment.dto.js';
import {
  CashClose,
  CashMovement,
  PAYMENT_METHODS,
  Payment,
  type PaymentDocument,
  type PaymentMethod,
} from './schemas/payment.schemas.js';

export interface PaymentView {
  id: string;
  number: number;
  appointmentId: string;
  branchId: string;
  professionalId: string;
  professionalName: string;
  clientId: string;
  clientName: string;
  serviceName: string;
  amount: number;
  discount: number;
  tip: number;
  total: number;
  methods: Array<{ method: PaymentMethod; amount: number; reference?: string }>;
  commissionAmount: number;
  localDate: string;
  status: 'paid' | 'voided';
  note?: string;
  voidReason?: string;
  createdAt: Date;
}

const emptyByMethod = () => Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0])) as Record<PaymentMethod, number>;

function cashClosed(date: string): AppError {
  return new AppError(HttpStatus.CONFLICT, 'CASH_CLOSED', `La caja del ${date} ya está cerrada. Reábrela para hacer cambios.`);
}

@Injectable()
export class PaymentsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
    @InjectModel(CashMovement.name) private readonly movements: Model<CashMovement>,
    @InjectModel(CashClose.name) private readonly closes: Model<CashClose>,
    @InjectModel(Appointment.name) private readonly appointments: Model<Appointment>,
    @InjectModel(Counter.name) private readonly counters: Model<Counter>,
    @InjectModel(Professional.name) private readonly professionals: Model<Professional>,
    @InjectModel(Client.name) private readonly clients: Model<Client>,
    @InjectModel(Branch.name) private readonly branches: Model<Branch>,
    private readonly appointmentsService: AppointmentsService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  /* ---------- Cobros de una cita ---------- */

  /** Precio, descuentos, pagado y saldo de una cita, con sus pagos. */
  async forAppointment(appointmentId: string) {
    const appt = await this.appointments.findOne({ _id: appointmentId, ...(await this.readFilter<Appointment>()) }).exec();
    if (!appt) throw Errors.notFound('Cita');
    const docs = await this.payments.find({ appointmentId }).sort({ createdAt: 1 }).exec();
    return { ...this.balance(appt, docs), payments: await this.toViews(docs) };
  }

  async create(appointmentId: string, dto: CreatePaymentDto) {
    const appt = await this.appointments.findById(appointmentId).exec();
    if (!appt) throw Errors.notFound('Cita');
    if (!canActOn('payment.create', { branchIds: [appt.branchId.toString()] })) throw Errors.forbidden();
    if (appt.status === 'cancelled') throw Errors.badRequest('APPOINTMENT_CANCELLED', 'No se puede cobrar una cita cancelada');
    if (dto.complete && appt.status === 'pending') {
      throw Errors.badRequest('NOT_CONFIRMED', 'Confirma la cita antes de cobrarla como completada');
    }

    const localDate = await this.today(appt.branchId.toString());
    await this.assertOpen(appt.branchId.toString(), localDate);

    const tip = dto.tip ?? 0;
    const discount = dto.discount ?? 0;
    const total = dto.methods.reduce((acc, m) => acc + m.amount, 0);
    const amount = total - tip;
    if (amount < 0) throw Errors.badRequest('INVALID_AMOUNT', 'La propina no puede ser mayor que lo cobrado');
    if (amount + discount + tip === 0) throw Errors.badRequest('INVALID_AMOUNT', 'Ingresa un monto');

    const pro = await this.professionals.findById(appt.professionalId).select('commissionPercent').exec();
    const created = await this.connection.transaction(async (session) => {
      const existing = await this.payments.find({ appointmentId, status: 'paid' }).session(session).exec();
      const { balance } = this.balance(appt, existing);
      if (amount + discount > balance) {
        throw Errors.badRequest('OVERPAYMENT', `El saldo pendiente es ${(balance / 100).toFixed(2)}. Lo demás regístralo como propina.`, { balance });
      }
      const counter = await this.counters
        .findOneAndUpdate({ key: 'payment' }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after', session })
        .exec();
      const pct = pro?.commissionPercent ?? null;
      const [doc] = await this.payments.create(
        [
          {
            number: counter!.value,
            branchId: appt.branchId,
            appointmentId: appt._id,
            clientId: appt.clientId,
            professionalId: appt.professionalId,
            serviceName: appt.serviceName,
            amount,
            discount,
            tip,
            methods: dto.methods,
            commissionPercent: pct,
            commissionAmount: pct != null ? Math.round((amount * pct) / 100) : 0,
            localDate,
            note: dto.note,
            createdBy: this.userId(),
          },
        ],
        { session },
      );
      return doc!;
    });

    await this.audit.log({
      action: 'payment.created',
      entityType: 'Payment',
      entityId: created.id as string,
      metadata: { appointmentId, amount, tip, discount },
    });
    if (dto.complete) await this.appointmentsService.complete(appointmentId);
    return this.forAppointment(appointmentId);
  }

  /* ---------- Adelantos de reservas online ---------- */

  /** Enlace temporal a la foto del comprobante. */
  async depositProof(appointmentId: string) {
    const appt = await this.appointments.findOne({ _id: appointmentId, ...(await this.readFilter<Appointment>()) }).exec();
    if (!appt?.deposit) throw Errors.notFound('Adelanto');
    return { url: await this.storage.url(appt.deposit.proofKey) };
  }

  /** Aprueba el adelanto: queda registrado como cobro y la cita se confirma. */
  async approveDeposit(appointmentId: string) {
    const appt = await this.appointments.findById(appointmentId).exec();
    if (!appt?.deposit) throw Errors.notFound('Adelanto');
    if (appt.deposit.status !== 'pending_review') throw Errors.badRequest('DEPOSIT_REVIEWED', 'Este adelanto ya fue revisado');
    await this.create(appointmentId, {
      methods: [{ method: appt.deposit.method, amount: appt.deposit.amount, reference: appt.deposit.reference }],
      note: 'Adelanto de la reserva online',
    });
    await this.appointments.updateOne(
      { _id: appointmentId },
      { 'deposit.status': 'approved', 'deposit.reviewedAt': new Date(), 'deposit.reviewedBy': this.userId() },
    ).exec();
    if (appt.status === 'pending') await this.appointmentsService.changeStatus(appointmentId, 'confirmed', 'Adelanto validado');
    await this.audit.log({ action: 'deposit.approved', entityType: 'Appointment', entityId: appointmentId, metadata: { amount: appt.deposit.amount } });
    return this.appointmentsService.get(appointmentId);
  }

  /** Rechaza el adelanto (comprobante ilegible, monto incorrecto…): la cita se cancela y se libera el horario. */
  async rejectDeposit(appointmentId: string, reason: string) {
    const appt = await this.appointments.findById(appointmentId).exec();
    if (!appt?.deposit) throw Errors.notFound('Adelanto');
    if (!canActOn('payment.create', { branchIds: [appt.branchId.toString()] })) throw Errors.forbidden();
    if (appt.deposit.status !== 'pending_review') throw Errors.badRequest('DEPOSIT_REVIEWED', 'Este adelanto ya fue revisado');
    await this.appointments.updateOne(
      { _id: appointmentId },
      { 'deposit.status': 'rejected', 'deposit.reviewedAt': new Date(), 'deposit.reviewedBy': this.userId(), 'deposit.rejectReason': reason },
    ).exec();
    if (['pending', 'confirmed'].includes(appt.status)) {
      await this.appointmentsService.changeStatus(appointmentId, 'cancelled', `Adelanto rechazado: ${reason}`, 'business');
    }
    await this.audit.log({ action: 'deposit.rejected', entityType: 'Appointment', entityId: appointmentId, metadata: { reason } });
    return this.appointmentsService.get(appointmentId);
  }

  async void(id: string, reason: string) {
    const payment = await this.payments.findById(id).exec();
    if (!payment) throw Errors.notFound('Pago');
    if (payment.status === 'voided') throw Errors.badRequest('ALREADY_VOIDED', 'Este pago ya está anulado');
    await this.assertOpen(payment.branchId.toString(), payment.localDate);
    payment.set({ status: 'voided', voidedAt: new Date(), voidedBy: this.userId(), voidReason: reason });
    await payment.save();
    await this.audit.log({ action: 'payment.voided', entityType: 'Payment', entityId: id, metadata: { reason } });
    return (await this.toViews([payment]))[0]!;
  }

  /* ---------- Listados ---------- */

  async list(q: ListPaymentsQuery) {
    const filter: QueryFilter<Payment> = {
      ...(await this.readFilter()),
      localDate: { $gte: q.from, $lte: q.to },
      ...(q.branchId && { branchId: q.branchId }),
      ...(q.professionalId && { professionalId: q.professionalId }),
      ...(q.status && { status: q.status }),
    };
    const docs = await this.payments.find(filter).sort({ createdAt: -1 }).limit(1000).exec();
    return { items: await this.toViews(docs), totals: this.totals(docs.filter((d) => d.status === 'paid')) };
  }

  /** Comisión y propinas por profesional en un rango. */
  async commissions(q: CommissionsQuery) {
    const docs = await this.payments
      .find({
        ...(await this.readFilter()),
        status: 'paid',
        localDate: { $gte: q.from, $lte: q.to },
        ...(q.branchId && { branchId: q.branchId }),
        ...(q.professionalId && { professionalId: q.professionalId }),
      })
      .exec();
    const pros = await this.professionals
      .find({ _id: { $in: [...new Set(docs.map((d) => d.professionalId.toString()))] } })
      .select('displayName color commissionPercent')
      .exec();
    const rows = new Map<string, { services: Set<string>; sales: number; commission: number; tips: number }>();
    for (const d of docs) {
      const key = d.professionalId.toString();
      const row = rows.get(key) ?? { services: new Set(), sales: 0, commission: 0, tips: 0 };
      row.services.add(d.appointmentId.toString());
      row.sales += d.amount;
      row.commission += d.commissionAmount;
      row.tips += d.tip;
      rows.set(key, row);
    }
    return [...rows].map(([professionalId, r]) => {
      const p = pros.find((x) => x.id === professionalId);
      return {
        professionalId,
        displayName: p?.displayName ?? 'Profesional',
        color: p?.color ?? null,
        commissionPercent: p?.commissionPercent ?? null,
        appointments: r.services.size,
        sales: r.sales,
        commission: r.commission,
        tips: r.tips,
        toPay: r.commission + r.tips,
      };
    }).sort((a, b) => b.sales - a.sales);
  }

  /* ---------- Caja ---------- */

  async cashDay(branchId: string, date: string) {
    this.assertBranch('payment.read', branchId);
    const [docs, movements, close] = await Promise.all([
      this.payments.find({ branchId, localDate: date }).sort({ createdAt: -1 }).exec(),
      this.movements.find({ branchId, localDate: date }).sort({ createdAt: 1 }).exec(),
      this.closes.findOne({ branchId, localDate: date }).exec(),
    ]);
    const paid = docs.filter((d) => d.status === 'paid');
    const totals = this.totals(paid);
    const cashIn = movements.filter((m) => m.type === 'in').reduce((a, m) => a + m.amount, 0);
    const cashOut = movements.filter((m) => m.type === 'out').reduce((a, m) => a + m.amount, 0);
    const opening = close?.openingCash ?? 0;
    return {
      branchId,
      date,
      totals,
      cashIn,
      cashOut,
      /** Efectivo que debería haber, sin contar el fondo inicial. */
      cashFromDay: totals.byMethod.cash + cashIn - cashOut,
      expectedCash: opening + totals.byMethod.cash + cashIn - cashOut,
      payments: await this.toViews(docs),
      movements: movements.map((m) => ({ id: m.id as string, type: m.type, amount: m.amount, concept: m.concept, createdAt: (m as unknown as { createdAt: Date }).createdAt })),
      close: close
        ? {
            openingCash: close.openingCash,
            expectedCash: close.expectedCash,
            countedCash: close.countedCash,
            difference: close.difference,
            notes: close.notes ?? '',
            closedAt: (close as unknown as { createdAt: Date }).createdAt,
          }
        : null,
    };
  }

  async addMovement(dto: CashMovementDto) {
    this.assertBranch('payment.create', dto.branchId);
    const localDate = await this.today(dto.branchId);
    await this.assertOpen(dto.branchId, localDate);
    const m = await this.movements.create({ ...dto, localDate, createdBy: this.userId() });
    await this.audit.log({ action: 'cash.movement', entityType: 'CashMovement', entityId: m.id as string, metadata: { ...dto } });
    return this.cashDay(dto.branchId, localDate);
  }

  async close(dto: CloseCashDto) {
    this.assertBranch('payment.create', dto.branchId);
    const today = await this.today(dto.branchId);
    if (dto.date > today) throw Errors.badRequest('FUTURE_DATE', 'No se puede cerrar un día que aún no llega');
    await this.assertOpen(dto.branchId, dto.date);
    const day = await this.cashDay(dto.branchId, dto.date);
    const expectedCash = dto.openingCash + day.cashFromDay;
    await this.closes.create({
      branchId: dto.branchId,
      localDate: dto.date,
      openingCash: dto.openingCash,
      expectedCash,
      countedCash: dto.countedCash,
      difference: dto.countedCash - expectedCash,
      totals: { ...day.totals.byMethod, tips: day.totals.tips, discount: day.totals.discount, cashIn: day.cashIn, cashOut: day.cashOut },
      notes: dto.notes,
      closedBy: this.userId(),
    });
    await this.audit.log({
      action: 'cash.closed',
      entityType: 'CashClose',
      metadata: { branchId: dto.branchId, date: dto.date, difference: dto.countedCash - expectedCash },
    });
    return this.cashDay(dto.branchId, dto.date);
  }

  async reopen(branchId: string, date: string) {
    const res = await this.closes.deleteOne({ branchId, localDate: date }).exec();
    if (res.deletedCount === 0) throw Errors.notFound('Cierre de caja');
    await this.audit.log({ action: 'cash.reopened', entityType: 'CashClose', metadata: { branchId, date } });
    return this.cashDay(branchId, date);
  }

  /* ---------- Internos ---------- */

  private userId(): string {
    return TenantContext.getActor()!.userId;
  }

  private balance(appt: AppointmentDocument, docs: PaymentDocument[]) {
    const paid = docs.filter((d) => d.status === 'paid');
    const discount = paid.reduce((a, d) => a + d.discount, 0);
    const amount = paid.reduce((a, d) => a + d.amount, 0);
    const tips = paid.reduce((a, d) => a + d.tip, 0);
    const balance = Math.max(0, appt.price - discount - amount);
    return {
      appointmentId: appt.id as string,
      price: appt.price,
      discount,
      paid: amount,
      tips,
      balance,
      status: balance === 0 ? 'paid' : amount + discount > 0 ? 'partial' : 'unpaid',
    } as const;
  }

  private totals(docs: PaymentDocument[]) {
    const byMethod = emptyByMethod();
    for (const d of docs) for (const m of d.methods) byMethod[m.method] += m.amount;
    return {
      count: docs.length,
      sales: docs.reduce((a, d) => a + d.amount, 0),
      tips: docs.reduce((a, d) => a + d.tip, 0),
      discount: docs.reduce((a, d) => a + d.discount, 0),
      collected: docs.reduce((a, d) => a + d.amount + d.tip, 0),
      byMethod,
    };
  }

  /** Día de caja actual en la zona horaria de la sede. */
  private async today(branchId: string): Promise<string> {
    const branch = await this.branches.findById(branchId).select('timezone').exec();
    if (!branch) throw Errors.notFound('Sucursal');
    return utcToZoned(new Date(), branch.timezone).date;
  }

  private async assertOpen(branchId: string, date: string): Promise<void> {
    if (await this.closes.exists({ branchId, localDate: date })) throw cashClosed(date);
  }

  private assertBranch(permission: 'payment.read' | 'payment.create', branchId: string): void {
    const scope = currentScope(permission);
    // Alcance "propio" (profesional): ve sus cobros, no la caja de la sede.
    if (!scope || scope === 'own' || !canActOn(permission, { branchIds: [branchId] })) throw Errors.forbidden();
  }

  /** Propio: solo cobros de su agenda. Sede: de sus sedes. */
  private async readFilter<T = Payment>(): Promise<QueryFilter<T>> {
    const access = TenantContext.getAccess();
    const scope = currentScope('payment.read');
    if (!access || !scope) throw Errors.forbidden();
    if (scope === 'organization') return {};
    if (scope === 'branch') return (access.branchIds.length ? { branchId: { $in: access.branchIds } } : {}) as QueryFilter<T>;
    const mine = await this.professionals.find({ membershipId: access.membershipId }).select('_id').exec();
    return { professionalId: { $in: mine.map((p) => p._id) } } as QueryFilter<T>;
  }

  private async toViews(docs: PaymentDocument[]): Promise<PaymentView[]> {
    const [clients, pros] = await Promise.all([
      this.clients.find({ _id: { $in: [...new Set(docs.map((d) => d.clientId.toString()))] } }).select('firstName lastName').exec(),
      this.professionals.find({ _id: { $in: [...new Set(docs.map((d) => d.professionalId.toString()))] } }).select('displayName').exec(),
    ]);
    return docs.map((d) => {
      const c = clients.find((x) => x.id === d.clientId.toString());
      return {
        id: d.id as string,
        number: d.number,
        appointmentId: d.appointmentId.toString(),
        branchId: d.branchId.toString(),
        professionalId: d.professionalId.toString(),
        professionalName: pros.find((p) => p.id === d.professionalId.toString())?.displayName ?? '',
        clientId: d.clientId.toString(),
        clientName: c ? `${c.firstName} ${c.lastName}`.trim() : 'Cliente',
        serviceName: d.serviceName,
        amount: d.amount,
        discount: d.discount,
        tip: d.tip,
        total: d.amount + d.tip,
        methods: d.methods.map((m) => ({ method: m.method, amount: m.amount, reference: m.reference })),
        commissionAmount: d.commissionAmount,
        localDate: d.localDate,
        status: d.status,
        note: d.note,
        voidReason: d.voidReason,
        createdAt: (d as unknown as { createdAt: Date }).createdAt,
      };
    });
  }
}
