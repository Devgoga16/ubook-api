import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, type HydratedDocument, type Types } from 'mongoose';
import { tenantPlugin } from '../../../core/database/tenant.plugin.js';

export const TIMES_OF_DAY = ['any', 'morning', 'afternoon', 'evening'] as const;
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];
export type WaitlistStatus = 'waiting' | 'booked' | 'removed';

/** Persona que espera un horario (por servicio, profesional, fechas y momento del día). */
@Schema({ timestamps: true, collection: 'waitlist' })
export class WaitlistEntry {
  organizationId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Branch', required: true })
  branchId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Service', required: true })
  serviceId: Types.ObjectId;

  /** `null` = cualquier profesional. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Professional', default: null })
  professionalId: Types.ObjectId | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Client', required: true, index: true })
  clientId: Types.ObjectId;

  /** Rango de fechas que le sirve ("YYYY-MM-DD", hora local de la sede). */
  @Prop({ required: true, match: /^\d{4}-\d{2}-\d{2}$/ })
  dateFrom: string;

  @Prop({ required: true, match: /^\d{4}-\d{2}-\d{2}$/ })
  dateTo: string;

  @Prop({ type: String, enum: TIMES_OF_DAY, default: 'any' })
  timeOfDay: TimeOfDay;

  @Prop({ trim: true })
  notes?: string;

  @Prop({ type: String, enum: ['waiting', 'booked', 'removed'], default: 'waiting' })
  status: WaitlistStatus;

  @Prop({ type: String, enum: ['backoffice', 'online'], default: 'backoffice' })
  source: 'backoffice' | 'online';

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Appointment', default: null })
  appointmentId: Types.ObjectId | null;

  /** Última vez que se le avisó de un horario libre. */
  @Prop({ type: Date, default: null })
  notifiedAt: Date | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  createdBy: Types.ObjectId | null;
}

export type WaitlistEntryDocument = HydratedDocument<WaitlistEntry>;
export const WaitlistEntrySchema = SchemaFactory.createForClass(WaitlistEntry);
WaitlistEntrySchema.plugin(tenantPlugin);
WaitlistEntrySchema.index({ organizationId: 1, branchId: 1, status: 1, dateTo: 1 });
