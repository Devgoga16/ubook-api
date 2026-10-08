import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, type HydratedDocument, type Types } from 'mongoose';
import { tenantPlugin } from '../../../core/database/tenant.plugin.js';
import { DayScheduleEntry } from '../../../core/scheduling/weekly-schedule.schema.js';

@Schema({ _id: false })
export class BranchScheduleEntry {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Branch', required: true })
  branchId: Types.ObjectId;

  @Prop({ type: [DayScheduleEntry], default: [] })
  days: DayScheduleEntry[];
}

/** Servicio que realiza el profesional, con precio o duración propios opcionales. */
@Schema({ _id: false })
export class ProfessionalServiceEntry {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Service', required: true })
  serviceId: Types.ObjectId;

  /** Céntimos. `null` = precio del servicio. */
  @Prop({ type: Number, default: null, min: 0 })
  price: number | null;

  /** `null` = duración del servicio. */
  @Prop({ type: Number, default: null, min: 5, max: 720 })
  durationMinutes: number | null;
}

/**
 * Quien atiende: barbero, psicóloga, terapeuta… Puede tener acceso al sistema
 * (membershipId) o ser solo alguien agendable.
 */
@Schema({ timestamps: true, collection: 'professionals' })
export class Professional {
  organizationId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  displayName: string;

  /** Cargo visible: "Barbero senior", "Psicóloga clínica". */
  @Prop({ trim: true })
  title?: string;

  @Prop({ default: '#243352', match: /^#[0-9a-fA-F]{6}$/ })
  color: string;

  @Prop({ trim: true, lowercase: true })
  email?: string;

  @Prop({ trim: true })
  phone?: string;

  @Prop({ trim: true })
  bio?: string;

  /** Usuario del equipo vinculado (para que vea "su" agenda). */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Membership', default: null })
  membershipId: Types.ObjectId | null;

  @Prop({ type: [{ type: SchemaTypes.ObjectId, ref: 'Branch' }], default: [] })
  branchIds: Types.ObjectId[];

  @Prop({ type: [ProfessionalServiceEntry], default: [] })
  services: ProfessionalServiceEntry[];

  @Prop({ type: [BranchScheduleEntry], default: [] })
  schedules: BranchScheduleEntry[];

  @Prop({ type: Number, default: null, min: 0, max: 100 })
  commissionPercent: number | null;

  @Prop({ default: true, index: true })
  isActive: boolean;

  @Prop({ default: 0 })
  sortOrder: number;

  /**
   * Se incrementa al reservar dentro de una transacción: dos reservas
   * simultáneas del mismo profesional chocan aquí y una se reintenta.
   */
  @Prop({ default: 0, select: false })
  bookingVersion: number;
}

export type ProfessionalDocument = HydratedDocument<Professional>;
export const ProfessionalSchema = SchemaFactory.createForClass(Professional);
ProfessionalSchema.plugin(tenantPlugin);
ProfessionalSchema.index(
  { organizationId: 1, membershipId: 1 },
  { unique: true, partialFilterExpression: { membershipId: { $type: 'objectId' } } },
);
