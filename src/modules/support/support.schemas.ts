import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, type HydratedDocument, type Types } from 'mongoose';
import { tenantPlugin } from '../../core/database/tenant.plugin.js';

/** Las tres últimas son temas de las consultas que un cliente final le hace al negocio. */
export const TICKET_CATEGORIES = ['bug', 'question', 'billing', 'request', 'other', 'appointment', 'payment', 'service'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/**
 * - open: esperando a soporte (nuevo o el negocio respondió).
 * - in_progress: soporte lo está revisando.
 * - waiting_customer: soporte respondió y espera al negocio.
 * - resolved: cerrado; si el negocio vuelve a escribir, se reabre.
 */
export const TICKET_STATUSES = ['open', 'in_progress', 'waiting_customer', 'resolved'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * Quién atiende el ticket:
 * - platform: el equipo de Unify Tec (lo abre el negocio, o un cliente final por un problema técnico).
 * - business: el propio negocio (consulta de un cliente final desde su portal).
 */
export const TICKET_AUDIENCES = ['platform', 'business'] as const;
export type TicketAudience = (typeof TICKET_AUDIENCES)[number];

/** Dónde estaba la persona al reportar: ayuda a reproducir el problema. */
@Schema({ _id: false })
class TicketContext {
  @Prop({ default: '' })
  path: string;

  @Prop({ default: '' })
  userAgent: string;

  @Prop({ default: '' })
  viewport: string;
}

/** Ticket de soporte que un negocio abre con Unify Tec. */
@Schema({ timestamps: true, collection: 'support_tickets' })
export class SupportTicket {
  organizationId: Types.ObjectId;

  /** Correlativo de toda la plataforma (#1001). */
  @Prop({ required: true, unique: true })
  number: number;

  @Prop({ required: true, trim: true })
  subject: string;

  @Prop({ type: String, enum: TICKET_CATEGORIES, default: 'question' })
  category: TicketCategory;

  @Prop({ type: String, enum: TICKET_PRIORITIES, default: 'normal' })
  priority: TicketPriority;

  @Prop({ type: String, enum: TICKET_STATUSES, default: 'open', index: true })
  status: TicketStatus;

  @Prop({ type: String, enum: TICKET_AUDIENCES, default: 'platform', index: true })
  audience: TicketAudience;

  /** Miembro del negocio que lo abrió. Vacío si lo abrió un cliente final. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  createdByUserId: Types.ObjectId | null;

  /** Cliente final que lo abrió desde el portal. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Client', default: null, index: true })
  clientId: Types.ObjectId | null;

  @Prop({ required: true })
  createdByName: string;

  /** Agente de plataforma a cargo. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  assignedToUserId: Types.ObjectId | null;

  @Prop({ type: TicketContext, default: () => ({}) })
  context: TicketContext;

  @Prop({ type: Date, required: true })
  lastMessageAt: Date;

  @Prop({ default: '' })
  lastMessagePreview: string;

  @Prop({ type: String, enum: ['customer', 'agent'], default: 'customer' })
  lastMessageFrom: 'customer' | 'agent';

  /** Hay una respuesta de soporte que el negocio no abrió. */
  @Prop({ default: false })
  customerUnread: boolean;

  /** Hay un mensaje del negocio que soporte no abrió. */
  @Prop({ default: true })
  agentUnread: boolean;

  @Prop({ type: Date, default: null })
  resolvedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export type SupportTicketDocument = HydratedDocument<SupportTicket>;
export const SupportTicketSchema = SchemaFactory.createForClass(SupportTicket);
SupportTicketSchema.plugin(tenantPlugin);
SupportTicketSchema.index({ status: 1, lastMessageAt: -1 });
SupportTicketSchema.index({ organizationId: 1, lastMessageAt: -1 });

/** Mensaje de la conversación de un ticket. */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'support_messages' })
export class SupportMessage {
  organizationId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'SupportTicket', required: true, index: true })
  ticketId: Types.ObjectId;

  @Prop({ type: String, enum: ['customer', 'agent'], required: true })
  from: 'customer' | 'agent';

  /** Vacío cuando escribe un cliente final (no tiene cuenta de usuario). */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  authorUserId: Types.ObjectId | null;

  @Prop({ required: true })
  authorName: string;

  @Prop({ required: true })
  body: string;

  /** Claves de las capturas en el almacenamiento privado. */
  @Prop({ type: [String], default: [] })
  attachments: string[];

  /** Nota interna del equipo de plataforma: el negocio nunca la ve. */
  @Prop({ default: false })
  internal: boolean;

  createdAt: Date;
}

export type SupportMessageDocument = HydratedDocument<SupportMessage>;
export const SupportMessageSchema = SchemaFactory.createForClass(SupportMessage);
SupportMessageSchema.plugin(tenantPlugin);

/** Correlativo global de tickets (no es de ningún negocio). */
@Schema({ collection: 'support_counters' })
export class SupportCounter {
  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ required: true })
  value: number;
}

export const SupportCounterSchema = SchemaFactory.createForClass(SupportCounter);
