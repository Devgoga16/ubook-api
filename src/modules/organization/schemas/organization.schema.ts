import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, Types, type HydratedDocument } from 'mongoose';

export type OrganizationStatus = 'active' | 'suspended';

export type ManualApproval = 'off' | 'new_clients' | 'all';

/**
 * Reglas que deciden qué horarios se ofrecen al reservar. `null` = regla
 * desactivada.
 */
@Schema({ _id: false })
export class BookingRules {
  /** No se puede reservar con menos de esta anticipación. */
  @Prop({ type: Number, default: 120, min: 0 })
  minNoticeMinutes: number | null;

  /** Hasta cuántos días adelante se puede reservar. */
  @Prop({ type: Number, default: 60, min: 1 })
  maxAdvanceDays: number | null;

  /** Cancelar con al menos esta anticipación no tiene costo. */
  @Prop({ type: Number, default: 12, min: 0 })
  freeCancellationHours: number | null;

  /** Cuántas veces el cliente puede mover su cita. */
  @Prop({ type: Number, default: 2, min: 0 })
  maxReschedules: number | null;

  /** Tiempo de limpieza sugerido al crear servicios. */
  @Prop({ type: Number, default: 10, min: 0, max: 240 })
  defaultBufferMinutes: number | null;

  /** Citas activas al mismo tiempo por cliente. */
  @Prop({ type: Number, default: null, min: 1 })
  maxActiveBookingsPerClient: number | null;

  /** Permitir dos citas en el mismo horario si hay recurso libre. */
  @Prop({ default: false })
  allowOverbooking: boolean;

  /** Reservas web que quedan pendientes hasta aprobarlas. */
  @Prop({ type: String, enum: ['off', 'new_clients', 'all'], default: 'off' })
  manualApproval: ManualApproval;
}

/** Dónde paga el cliente el adelanto (se muestra en la página de reservas). */
@Schema({ _id: false })
export class DepositInfo {
  /** "987 654 321 · Barbería Norte" */
  @Prop({ trim: true, default: '' })
  yape: string;

  @Prop({ trim: true, default: '' })
  plin: string;

  /** Banco, cuenta y CCI. */
  @Prop({ trim: true, default: '' })
  bank: string;

  @Prop({ trim: true, default: '' })
  notes: string;
}

/** Negocio (tenant). Colección global: es la raíz del aislamiento. */
@Schema({ timestamps: true, collection: 'organizations' })
export class Organization {
  @Prop({ required: true, trim: true })
  name: string;

  /** Identificador público para la URL de reservas: /{slug}. */
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug: string;

  /** Zona horaria por defecto para sucursales nuevas (IANA). */
  @Prop({ required: true })
  timezone: string;

  @Prop({ default: 'es' })
  locale: string;

  /** Por ahora solo operamos en Perú. */
  @Prop({ uppercase: true, minlength: 3, maxlength: 3, default: 'PEN' })
  currency: string;

  @Prop({ uppercase: true, minlength: 2, maxlength: 2, default: 'PE' })
  country: string;

  /** Plantilla de rubro usada al crearla (barbería, psicología...). Solo informativo. */
  @Prop()
  businessType?: string;

  @Prop({ type: String, enum: ['active', 'suspended'], default: 'active' })
  status: OrganizationStatus;

  @Prop({ type: BookingRules, default: () => ({}) })
  bookingRules: BookingRules;

  @Prop({ type: DepositInfo, default: () => ({}) })
  depositInfo: DepositInfo;

  /** Logo del negocio en el almacenamiento privado (`logos/<orgId>/…`). Se expone como `logoUrl` firmado. */
  @Prop({ type: String, default: null })
  logoKey: string | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;
}

export type OrganizationDocument = HydratedDocument<Organization>;
export const OrganizationSchema = SchemaFactory.createForClass(Organization);
