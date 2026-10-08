import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, type HydratedDocument, type Types } from 'mongoose';
import { tenantPlugin } from '../../../core/database/tenant.plugin.js';

export const PAYMENT_METHODS = ['cash', 'yape', 'plin', 'card', 'transfer', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

@Schema({ _id: false })
export class PaymentPart {
  @Prop({ type: String, enum: PAYMENT_METHODS, required: true })
  method: PaymentMethod;

  /** Céntimos. */
  @Prop({ required: true, min: 1 })
  amount: number;

  /** N.º de operación de Yape/Plin, voucher del POS… */
  @Prop({ trim: true })
  reference?: string;
}

/**
 * Un cobro (recibo interno, no comprobante SUNAT). Montos en céntimos:
 * total cobrado = amount (servicio) + tip; methods suma ese total.
 */
@Schema({ timestamps: true, collection: 'payments' })
export class Payment {
  organizationId: Types.ObjectId;

  @Prop({ required: true })
  number: number;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Branch', required: true })
  branchId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Appointment', required: true, index: true })
  appointmentId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Client', required: true })
  clientId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Professional', required: true })
  professionalId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  serviceName: string;

  /** Lo que se aplica al precio del servicio. */
  @Prop({ required: true, min: 0 })
  amount: number;

  @Prop({ default: 0, min: 0 })
  discount: number;

  @Prop({ default: 0, min: 0 })
  tip: number;

  @Prop({ type: [PaymentPart], required: true })
  methods: PaymentPart[];

  /** Comisión congelada al cobrar (cambios de % no alteran pagos pasados). */
  @Prop({ type: Number, default: null })
  commissionPercent: number | null;

  @Prop({ default: 0 })
  commissionAmount: number;

  /** Día de caja en la zona de la sede ("YYYY-MM-DD"). */
  @Prop({ required: true, match: /^\d{4}-\d{2}-\d{2}$/ })
  localDate: string;

  @Prop({ type: String, enum: ['paid', 'voided'], default: 'paid' })
  status: 'paid' | 'voided';

  @Prop({ trim: true })
  note?: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;

  @Prop({ type: Date, default: null })
  voidedAt: Date | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  voidedBy: Types.ObjectId | null;

  @Prop({ trim: true })
  voidReason?: string;
}

export type PaymentDocument = HydratedDocument<Payment>;
export const PaymentSchema = SchemaFactory.createForClass(Payment);
PaymentSchema.plugin(tenantPlugin);
PaymentSchema.index({ organizationId: 1, number: 1 }, { unique: true });
PaymentSchema.index({ organizationId: 1, branchId: 1, localDate: 1 });

/** Entrada o salida de efectivo que no es un cobro (gastos, retiros, cambio). */
@Schema({ timestamps: true, collection: 'cash_movements' })
export class CashMovement {
  organizationId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Branch', required: true })
  branchId: Types.ObjectId;

  @Prop({ required: true, match: /^\d{4}-\d{2}-\d{2}$/ })
  localDate: string;

  @Prop({ type: String, enum: ['in', 'out'], required: true })
  type: 'in' | 'out';

  @Prop({ required: true, min: 1 })
  amount: number;

  @Prop({ required: true, trim: true })
  concept: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;
}

export type CashMovementDocument = HydratedDocument<CashMovement>;
export const CashMovementSchema = SchemaFactory.createForClass(CashMovement);
CashMovementSchema.plugin(tenantPlugin);
CashMovementSchema.index({ organizationId: 1, branchId: 1, localDate: 1 });

/** Cierre de caja de un día en una sede. Mientras exista, ese día no admite cambios. */
@Schema({ timestamps: true, collection: 'cash_closes' })
export class CashClose {
  organizationId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Branch', required: true })
  branchId: Types.ObjectId;

  @Prop({ required: true, match: /^\d{4}-\d{2}-\d{2}$/ })
  localDate: string;

  /** Fondo con el que abrió la caja. */
  @Prop({ default: 0, min: 0 })
  openingCash: number;

  @Prop({ required: true })
  expectedCash: number;

  @Prop({ required: true, min: 0 })
  countedCash: number;

  /** countedCash − expectedCash (negativo = falta dinero). */
  @Prop({ required: true })
  difference: number;

  /** Totales por método al momento del cierre. */
  @Prop({ type: SchemaTypes.Mixed, default: {} })
  totals: Record<string, number>;

  @Prop({ trim: true })
  notes?: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  closedBy: Types.ObjectId;
}

export type CashCloseDocument = HydratedDocument<CashClose>;
export const CashCloseSchema = SchemaFactory.createForClass(CashClose);
CashCloseSchema.plugin(tenantPlugin);
CashCloseSchema.index({ organizationId: 1, branchId: 1, localDate: 1 }, { unique: true });
