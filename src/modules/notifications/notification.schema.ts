import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, type HydratedDocument, type Types } from 'mongoose';
import { tenantPlugin } from '../../core/database/tenant.plugin.js';

export const NOTIFICATION_TYPES = ['booking_created', 'booking_pending', 'deposit_submitted', 'booking_cancelled', 'booking_rescheduled', 'waitlist_joined'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Se borran solas a los 60 días. */
const TTL_SECONDS = 60 * 24 * 60 * 60;

/** Aviso para el equipo: lo que hacen los clientes sin pasar por el panel. */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'notifications' })
export class Notification {
  organizationId: Types.ObjectId;

  @Prop({ type: String, enum: NOTIFICATION_TYPES, required: true })
  type: NotificationType;

  @Prop({ required: true })
  title: string;

  @Prop({ default: '' })
  body: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Appointment', default: null })
  appointmentId: Types.ObjectId | null;

  /** Para filtrar por alcance: sede y profesional involucrados. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Branch', default: null })
  branchId: Types.ObjectId | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Professional', default: null })
  professionalId: Types.ObjectId | null;

  createdAt: Date;
}

export type NotificationDocument = HydratedDocument<Notification>;
export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.plugin(tenantPlugin);
NotificationSchema.index({ organizationId: 1, createdAt: -1 });
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });
