import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, type HydratedDocument, type Types } from 'mongoose';
import { tenantPlugin } from '../../../core/database/tenant.plugin.js';

export const FLOWS = ['reminder', 'confirmation', 'review', 'reactivation', 'birthday', 'noShow'] as const;
export type FlowKey = (typeof FLOWS)[number];
export const CHANNELS = ['email', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Flujos promocionales: solo a clientes que aceptaron promociones. */
export const MARKETING_FLOWS: FlowKey[] = ['reactivation', 'birthday'];

@Schema({ _id: false })
export class FlowSettings {
  @Prop({ default: false })
  enabled: boolean;

  @Prop({ type: [String], enum: CHANNELS, default: ['email'] })
  channels: Channel[];

  /** Horas (recordatorio: antes; reseña: después) o días (reactivar: sin visita). */
  @Prop({ type: Number, default: null })
  offset: number | null;

  /** Texto con variables {{cliente.nombre}}… Vacío = el mensaje por defecto. */
  @Prop({ trim: true, default: '' })
  message: string;

  /** Cupón que se ofrece (cumpleaños, reactivar). */
  @Prop({ type: String, default: null })
  promoCode: string | null;

  /** Enlace de reseñas (Google, Facebook…). */
  @Prop({ type: String, default: null })
  link: string | null;
}

const flow = (enabled: boolean, offset: number | null = null) => ({ type: FlowSettings, default: () => ({ enabled, channels: ['email'], offset, message: '', promoCode: null, link: null }) });

/** Configuración de automatizaciones de un negocio (un documento por negocio). */
@Schema({ timestamps: true, collection: 'automation_settings' })
export class AutomationSettings {
  organizationId: Types.ObjectId;

  @Prop(flow(true, 24))
  reminder: FlowSettings;

  @Prop(flow(true))
  confirmation: FlowSettings;

  @Prop(flow(false, 2))
  review: FlowSettings;

  @Prop(flow(false, 45))
  reactivation: FlowSettings;

  @Prop(flow(false))
  birthday: FlowSettings;

  @Prop(flow(false))
  noShow: FlowSettings;

  /** Último día (local) en que corrieron los flujos diarios. */
  @Prop({ type: String, default: null })
  lastDailyRun: string | null;
}

export type AutomationSettingsDocument = HydratedDocument<AutomationSettings>;
export const AutomationSettingsSchema = SchemaFactory.createForClass(AutomationSettings);
AutomationSettingsSchema.plugin(tenantPlugin);
AutomationSettingsSchema.index({ organizationId: 1 }, { unique: true });

/** Registro de cada mensaje enviado (o fallido) a un cliente. */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'notification_log' })
export class NotificationLog {
  organizationId: Types.ObjectId;

  /** Flujo o aviso: reminder, confirmation, cancelled, rescheduled… */
  @Prop({ required: true })
  flow: string;

  @Prop({ type: String, enum: CHANNELS, required: true })
  channel: Channel;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Client', default: null })
  clientId: Types.ObjectId | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Appointment', default: null })
  appointmentId: Types.ObjectId | null;

  @Prop({ required: true })
  to: string;

  @Prop({ type: String, enum: ['sent', 'failed'], required: true })
  status: 'sent' | 'failed';

  @Prop()
  error?: string;

  /** Envío de prueba desde la pantalla de automatizaciones. */
  @Prop({ default: false })
  test: boolean;
}

export type NotificationLogDocument = HydratedDocument<NotificationLog>;
export const NotificationLogSchema = SchemaFactory.createForClass(NotificationLog);
NotificationLogSchema.plugin(tenantPlugin);
NotificationLogSchema.index({ organizationId: 1, createdAt: -1 });
NotificationLogSchema.index({ organizationId: 1, flow: 1, clientId: 1, createdAt: -1 });
