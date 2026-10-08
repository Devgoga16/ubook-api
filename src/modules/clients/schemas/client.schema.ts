import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, type HydratedDocument, type Types } from 'mongoose';
import { tenantPlugin } from '../../../core/database/tenant.plugin.js';

export const CONTACT_CHANNELS = ['whatsapp', 'call', 'sms', 'email'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/**
 * Cliente del negocio (quien recibe el servicio). Puede existir sin cuenta
 * de usuario: lo registra el equipo o reserva como invitado.
 */
@Schema({ timestamps: true, collection: 'clients' })
export class Client {
  organizationId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  firstName: string;

  @Prop({ trim: true, default: '' })
  lastName: string;

  /** Celular en formato E.164 (+51987654321). */
  @Prop({ trim: true })
  phone?: string;

  @Prop({ trim: true, lowercase: true })
  email?: string;

  /** Fecha de nacimiento "YYYY-MM-DD" (para saludos y edad). */
  @Prop({ match: /^\d{4}-\d{2}-\d{2}$/ })
  birthDate?: string;

  /** DNI, CE o pasaporte, si el negocio lo pide. */
  @Prop({ trim: true })
  documentId?: string;

  @Prop({ trim: true })
  address?: string;

  /** Cómo conoció el negocio: Instagram, recomendación, Google… */
  @Prop({ trim: true })
  source?: string;

  @Prop({ type: String, enum: CONTACT_CHANNELS, default: 'whatsapp' })
  preferredChannel: ContactChannel;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Professional', default: null })
  preferredProfessionalId: Types.ObjectId | null;

  /** Acepta recibir promociones y recordatorios. */
  @Prop({ default: false })
  marketingConsent: boolean;

  /** Cuándo aceptó el tratamiento de sus datos personales (Ley 29733). */
  @Prop({ type: Date, default: null })
  dataConsentAt: Date | null;

  /** Nota interna: solo la ve el equipo. */
  @Prop({ trim: true })
  notes?: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  /** Cuenta de usuario vinculada (portal del cliente). */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', default: null })
  userId: Types.ObjectId | null;

  /** Texto normalizado para búsqueda (nombre, celular, email). */
  @Prop({ select: false, index: true })
  searchText?: string;
}

export type ClientDocument = HydratedDocument<Client>;
export const ClientSchema = SchemaFactory.createForClass(Client);
ClientSchema.plugin(tenantPlugin);
// El celular se puede compartir (una mamá que agenda a sus hijos); se avisa al registrarlo.
ClientSchema.index({ organizationId: 1, phone: 1 });
// El DNI identifica a una sola persona: una ficha clínica no puede quedar partida en dos perfiles.
ClientSchema.index(
  { organizationId: 1, documentId: 1 },
  { unique: true, partialFilterExpression: { documentId: { $type: 'string' } } },
);

export function normalizeSearch(...parts: Array<string | undefined>): string {
  return parts
    .filter(Boolean)
    .join(' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

ClientSchema.pre('validate', function () {
  this.set('searchText', normalizeSearch(this.firstName, this.lastName, this.phone, this.email, this.documentId));
});
