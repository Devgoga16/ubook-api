import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, type HydratedDocument, type Types } from 'mongoose';
import { tenantPlugin } from '../../../core/database/tenant.plugin.js';
import { FIELD_TYPES, type FieldType } from '../record-fields.js';

@Schema({ _id: false })
export class RecordFieldEntry {
  @Prop({ required: true })
  key: string;

  @Prop({ required: true, trim: true })
  label: string;

  @Prop({ type: String, enum: FIELD_TYPES, required: true })
  type: FieldType;

  @Prop({ default: false })
  required: boolean;

  @Prop({ type: [String], default: [] })
  options: string[];

  @Prop({ trim: true })
  helpText?: string;
}

/** Plantilla de ficha que define cada negocio (qué se registra en cada atención). */
@Schema({ timestamps: true, collection: 'record_templates' })
export class RecordTemplate {
  organizationId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ trim: true })
  description?: string;

  @Prop({ type: [RecordFieldEntry], default: [] })
  fields: RecordFieldEntry[];

  @Prop({ default: true })
  isActive: boolean;
}

export type RecordTemplateDocument = HydratedDocument<RecordTemplate>;
export const RecordTemplateSchema = SchemaFactory.createForClass(RecordTemplate);
RecordTemplateSchema.plugin(tenantPlugin);

@Schema({ _id: false })
export class RecordAddendum {
  /** Texto cifrado. */
  @Prop({ required: true })
  payload: string;

  @Prop({ required: true })
  at: Date;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  byUserId: Types.ObjectId;
}

/**
 * Entrada de ficha de un cliente. El contenido va cifrado. Una vez firmada no
 * se modifica: solo se agregan notas de corrección (addenda).
 */
@Schema({ timestamps: true, collection: 'client_records' })
export class ClientRecord {
  organizationId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Client', required: true, index: true })
  clientId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'RecordTemplate', required: true })
  templateId: Types.ObjectId;

  /** Copia de la plantilla al escribir: cambiarla después no altera fichas existentes. */
  @Prop({ required: true })
  templateName: string;

  @Prop({ type: [RecordFieldEntry], default: [] })
  fields: RecordFieldEntry[];

  /** Valores cifrados (JSON). */
  @Prop({ required: true })
  payload: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Appointment', default: null })
  appointmentId: Types.ObjectId | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Professional', default: null })
  professionalId: Types.ObjectId | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true, index: true })
  authorUserId: Types.ObjectId;

  @Prop({ type: String, enum: ['draft', 'signed'], default: 'draft' })
  status: 'draft' | 'signed';

  @Prop({ type: Date, default: null })
  signedAt: Date | null;

  @Prop({ type: [RecordAddendum], default: [] })
  addenda: RecordAddendum[];
}

export type ClientRecordDocument = HydratedDocument<ClientRecord>;
export const ClientRecordSchema = SchemaFactory.createForClass(ClientRecord);
ClientRecordSchema.plugin(tenantPlugin);
ClientRecordSchema.index({ organizationId: 1, clientId: 1, createdAt: -1 });
