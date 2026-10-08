import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, type HydratedDocument, type Types } from 'mongoose';
import { tenantPlugin } from '../../../core/database/tenant.plugin.js';

/**
 * Flujo normal: pending → confirmed → checked_in → in_progress → completed.
 * Salidas: cancelled, no_show.
 */
export const APPOINTMENT_STATUSES = [
  'pending',
  'confirmed',
  'checked_in',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Estados que ocupan el horario en la agenda. */
export const BLOCKING_STATUSES: AppointmentStatus[] = ['pending', 'confirmed', 'checked_in', 'in_progress', 'completed'];

export const ALLOWED_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'in_progress', 'cancelled', 'no_show', 'pending'],
  checked_in: ['in_progress', 'completed', 'cancelled', 'confirmed'],
  in_progress: ['completed', 'checked_in'],
  completed: ['in_progress'],
  cancelled: [],
  no_show: ['confirmed'],
};

@Schema({ _id: false, timestamps: false })
export class StatusChange {
  @Prop({ type: String, enum: APPOINTMENT_STATUSES, required: true })
  status: AppointmentStatus;

  @Prop({ required: true })
  at: Date;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User' })
  byUserId?: Types.ObjectId;

  @Prop({ trim: true })
  note?: string;
}

export const DEPOSIT_METHODS = ['yape', 'plin', 'transfer', 'other'] as const;
export type DepositMethod = (typeof DEPOSIT_METHODS)[number];

/** Adelanto pagado por el cliente al reservar online, con su comprobante. */
@Schema({ _id: false })
export class AppointmentDeposit {
  /** Céntimos. */
  @Prop({ required: true, min: 1 })
  amount: number;

  @Prop({ type: String, enum: ['pending_review', 'approved', 'rejected'], default: 'pending_review' })
  status: 'pending_review' | 'approved' | 'rejected';

  /** Clave del comprobante en el almacenamiento privado. */
  @Prop({ required: true })
  proofKey: string;

  @Prop({ type: String, enum: DEPOSIT_METHODS, required: true })
  method: DepositMethod;

  @Prop({ trim: true })
  reference?: string;

  @Prop({ required: true })
  submittedAt: Date;

  @Prop({ type: Date, default: null })
  reviewedAt: Date | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  reviewedBy: Types.ObjectId | null;

  @Prop({ trim: true })
  rejectReason?: string;
}

/** Una cita: un servicio, con un profesional, en una sede, a una hora. */
@Schema({ timestamps: true, collection: 'appointments' })
export class Appointment {
  organizationId: Types.ObjectId;

  /** Número correlativo por negocio (#UB-1001). */
  @Prop({ required: true })
  number: number;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Branch', required: true })
  branchId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Professional', required: true })
  professionalId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Service', required: true })
  serviceId: Types.ObjectId;

  /** Quien recibe el servicio (beneficiario). */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Client', required: true, index: true })
  clientId: Types.ObjectId;

  @Prop({ required: true })
  startsAt: Date;

  @Prop({ required: true })
  endsAt: Date;

  /** Rango ocupado en la agenda, con tiempos antes/después del servicio. */
  @Prop({ required: true })
  blockedFrom: Date;

  @Prop({ required: true })
  blockedUntil: Date;

  @Prop({ type: String, enum: APPOINTMENT_STATUSES, required: true })
  status: AppointmentStatus;

  /** Datos congelados al reservar: un cambio de precio no altera citas existentes. */
  @Prop({ required: true, trim: true })
  serviceName: string;

  @Prop({ required: true, min: 0 })
  price: number;

  @Prop({ required: true, min: 5 })
  durationMinutes: number;

  @Prop({ type: String, enum: ['backoffice', 'online'], default: 'backoffice' })
  channel: 'backoffice' | 'online';

  @Prop({ trim: true })
  notes?: string;

  @Prop({ default: 0 })
  rescheduleCount: number;

  @Prop({ type: [StatusChange], default: [] })
  history: StatusChange[];

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;

  /** Adelanto por validar o validado (solo reservas online de servicios con adelanto). */
  @Prop({ type: AppointmentDeposit, default: null })
  deposit: AppointmentDeposit | null;

  /** Recurso asignado (sala, camilla, equipo), si el servicio lo necesita. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Resource', default: null })
  resourceId: Types.ObjectId | null;

  /** Precio antes del cupón (si se usó uno). */
  @Prop({ type: Number, default: null })
  listPrice: number | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Promotion', default: null, index: true })
  promotionId: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  promotionCode: string | null;

  /** Pedido de reseña enviado (evita duplicados). */
  @Prop({ type: Date, default: null })
  reviewRequestedAt: Date | null;

  /** Recordatorio de 24 h enviado (evita duplicados). */
  @Prop({ type: Date, default: null })
  reminderSentAt: Date | null;
}

export type AppointmentDocument = HydratedDocument<Appointment>;
export const AppointmentSchema = SchemaFactory.createForClass(Appointment);
AppointmentSchema.plugin(tenantPlugin);
AppointmentSchema.index({ organizationId: 1, number: 1 }, { unique: true });
AppointmentSchema.index({ organizationId: 1, professionalId: 1, blockedFrom: 1 });
AppointmentSchema.index({ organizationId: 1, branchId: 1, startsAt: 1 });
AppointmentSchema.index({ status: 1, reminderSentAt: 1, startsAt: 1 });
AppointmentSchema.index({ organizationId: 1, resourceId: 1, blockedFrom: 1 });
