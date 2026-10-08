import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter } from 'mongoose';
import { AuditService } from '../../core/audit/audit.service.js';
import { currentScope } from '../../core/authorization/scope.js';
import { AppError, Errors } from '../../core/common/errors.js';
import { FieldCryptoService } from '../../core/security/field-crypto.service.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { Appointment } from '../bookings/schemas/appointment.schema.js';
import { Client } from '../clients/schemas/client.schema.js';
import { Professional } from '../professionals/schemas/professional.schema.js';
import type { CreateRecordDto, CreateTemplateDto, UpdateTemplateDto } from './dto/record.dto.js';
import { validateFields, validateValues, type RecordField, type RecordValues } from './record-fields.js';
import { RECORD_PRESETS } from './record-presets.js';
import {
  ClientRecord,
  RecordTemplate,
  type ClientRecordDocument,
  type RecordTemplateDocument,
} from './schemas/record.schemas.js';

export interface RecordView {
  id: string;
  clientId: string;
  templateId: string;
  templateName: string;
  fields: RecordField[];
  values: RecordValues;
  appointmentId: string | null;
  professionalId: string | null;
  authorUserId: string;
  status: 'draft' | 'signed';
  signedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  addenda: Array<{ text: string; at: Date; byUserId: string }>;
  /** Lo puede editar o firmar quien consulta (autor y en borrador). */
  canEdit: boolean;
}

function invalidValues(errors: Record<string, string>): AppError {
  return new AppError(HttpStatus.BAD_REQUEST, 'INVALID_RECORD', 'Revisa los campos de la ficha', { fields: errors });
}

@Injectable()
export class RecordsService {
  constructor(
    @InjectModel(RecordTemplate.name) private readonly templates: Model<RecordTemplate>,
    @InjectModel(ClientRecord.name) private readonly records: Model<ClientRecord>,
    @InjectModel(Client.name) private readonly clients: Model<Client>,
    @InjectModel(Appointment.name) private readonly appointments: Model<Appointment>,
    @InjectModel(Professional.name) private readonly professionals: Model<Professional>,
    private readonly crypto: FieldCryptoService,
    private readonly audit: AuditService,
  ) {}

  /* ---------- Plantillas ---------- */

  listTemplates(includeInactive = false): Promise<RecordTemplateDocument[]> {
    return this.templates.find(includeInactive ? {} : { isActive: true }).sort({ createdAt: 1 }).exec();
  }

  presets() {
    return RECORD_PRESETS.map(({ key, name, description, fields }) => ({ key, name, description, fieldCount: fields.length }));
  }

  async createTemplate(dto: CreateTemplateDto): Promise<RecordTemplateDocument> {
    const preset = dto.preset ? RECORD_PRESETS.find((p) => p.key === dto.preset) : undefined;
    if (dto.preset && !preset) throw Errors.badRequest('INVALID_PRESET', 'Plantilla base desconocida');
    const name = dto.name ?? preset?.name;
    const fields = (dto.fields ?? preset?.fields ?? []) as RecordField[];
    if (!name) throw Errors.badRequest('NAME_REQUIRED', 'Ponle un nombre a la plantilla');
    const problem = validateFields(fields);
    if (problem) throw Errors.badRequest('INVALID_TEMPLATE', problem);
    const template = await this.templates.create({ name, description: dto.description ?? preset?.description, fields });
    await this.audit.log({ action: 'record_template.created', entityType: 'RecordTemplate', entityId: template.id as string });
    return template;
  }

  async updateTemplate(id: string, dto: UpdateTemplateDto): Promise<RecordTemplateDocument> {
    const template = await this.templates.findById(id).exec();
    if (!template) throw Errors.notFound('Plantilla');
    if (dto.fields) {
      const problem = validateFields(dto.fields as RecordField[]);
      if (problem) throw Errors.badRequest('INVALID_TEMPLATE', problem);
    }
    template.set(dto);
    await template.save();
    await this.audit.log({ action: 'record_template.updated', entityType: 'RecordTemplate', entityId: id });
    return template;
  }

  /* ---------- Fichas de un cliente ---------- */

  /** Cada consulta queda en la auditoría: son datos sensibles. */
  async listForClient(clientId: string): Promise<RecordView[]> {
    await this.assertClient(clientId);
    const docs = await this.records
      .find({ clientId, ...(await this.readFilter()) })
      .sort({ createdAt: -1 })
      .exec();
    await this.audit.log({
      action: 'client_record.viewed',
      entityType: 'Client',
      entityId: clientId,
      metadata: { count: docs.length },
    });
    return docs.map((d) => this.toView(d));
  }

  async create(clientId: string, dto: CreateRecordDto): Promise<RecordView> {
    await this.assertClient(clientId);
    await this.assertCanWriteFor(clientId);
    const template = await this.templates.findOne({ _id: dto.templateId, isActive: true }).exec();
    if (!template) throw Errors.badRequest('INVALID_TEMPLATE', 'Plantilla inválida');

    const fields = template.fields as RecordField[];
    const { values, errors } = validateValues(fields, dto.values, { requireAll: dto.sign === true });
    if (Object.keys(errors).length) throw invalidValues(errors);

    let professionalId = null;
    if (dto.appointmentId) {
      const appt = await this.appointments.findOne({ _id: dto.appointmentId, clientId }).exec();
      if (!appt) throw Errors.badRequest('INVALID_APPOINTMENT', 'La cita no es de este cliente');
      professionalId = appt.professionalId;
    } else {
      professionalId = (await this.myProfessional())?._id ?? null;
    }

    const record = await this.records.create({
      clientId,
      templateId: template._id,
      templateName: template.name,
      fields,
      payload: this.crypto.encryptJson(values),
      appointmentId: dto.appointmentId ?? null,
      professionalId,
      authorUserId: this.userId(),
      status: dto.sign ? 'signed' : 'draft',
      signedAt: dto.sign ? new Date() : null,
    });
    await this.audit.log({ action: 'client_record.created', entityType: 'ClientRecord', entityId: record.id as string, metadata: { signed: !!dto.sign } });
    return this.toView(record);
  }

  async update(id: string, input: Record<string, unknown>): Promise<RecordView> {
    const record = await this.findOwnDraft(id);
    const { values, errors } = validateValues(record.fields as RecordField[], input, { requireAll: false });
    if (Object.keys(errors).length) throw invalidValues(errors);
    record.payload = this.crypto.encryptJson(values);
    await record.save();
    await this.audit.log({ action: 'client_record.updated', entityType: 'ClientRecord', entityId: id });
    return this.toView(record);
  }

  /** Firmar: valida obligatorios y deja la ficha cerrada. */
  async sign(id: string): Promise<RecordView> {
    const record = await this.findOwnDraft(id);
    const current = this.crypto.decryptJson<RecordValues>(record.payload);
    const { errors } = validateValues(record.fields as RecordField[], current, { requireAll: true });
    if (Object.keys(errors).length) throw invalidValues(errors);
    record.status = 'signed';
    record.signedAt = new Date();
    await record.save();
    await this.audit.log({ action: 'client_record.signed', entityType: 'ClientRecord', entityId: id });
    return this.toView(record);
  }

  /** Nota de corrección sobre una ficha firmada (la original no cambia). */
  async addAddendum(id: string, text: string): Promise<RecordView> {
    const record = await this.records.findOne({ _id: id, ...(await this.readFilter()) }).exec();
    if (!record) throw Errors.notFound('Ficha');
    if (record.status !== 'signed') throw Errors.badRequest('NOT_SIGNED', 'Edita el borrador directamente');
    const scope = currentScope('client_record.write');
    if (!scope || (scope === 'own' && record.authorUserId.toString() !== this.userId())) throw Errors.forbidden();
    record.addenda.push({ payload: this.crypto.encrypt(text.trim()), at: new Date(), byUserId: this.userId() as never });
    await record.save();
    await this.audit.log({ action: 'client_record.addendum', entityType: 'ClientRecord', entityId: id });
    return this.toView(record);
  }

  /* ---------- Internos ---------- */

  private userId(): string {
    return TenantContext.getActor()!.userId;
  }

  private async myProfessional() {
    const access = TenantContext.getAccess();
    return access ? this.professionals.findOne({ membershipId: access.membershipId }).select('_id').exec() : null;
  }

  /** Alcance "propio": solo las fichas que escribió. */
  private async readFilter(): Promise<QueryFilter<ClientRecord>> {
    const scope = currentScope('client_record.read');
    if (!scope) throw Errors.forbidden();
    return scope === 'own' ? { authorUserId: this.userId() } : {};
  }

  /** Alcance "propio": solo para clientes que atiende. */
  private async assertCanWriteFor(clientId: string): Promise<void> {
    const scope = currentScope('client_record.write');
    if (!scope) throw Errors.forbidden();
    if (scope === 'own') {
      const mine = await this.myProfessional();
      if (!mine || !(await this.appointments.exists({ clientId, professionalId: mine._id }))) {
        throw Errors.forbidden('Solo puedes escribir fichas de clientes que atiendes');
      }
    }
  }

  private async assertClient(clientId: string): Promise<void> {
    if (!(await this.clients.exists({ _id: clientId }))) throw Errors.notFound('Cliente');
  }

  private async findOwnDraft(id: string): Promise<ClientRecordDocument> {
    const record = await this.records.findOne({ _id: id, ...(await this.readFilter()) }).exec();
    if (!record) throw Errors.notFound('Ficha');
    if (record.status === 'signed') throw Errors.conflict('RECORD_SIGNED', 'La ficha está firmada: agrega una nota de corrección');
    if (record.authorUserId.toString() !== this.userId()) throw Errors.forbidden('Solo quien la escribió puede editarla');
    return record;
  }

  private toView(d: ClientRecordDocument): RecordView {
    const me = TenantContext.getActor()?.userId;
    return {
      id: d.id as string,
      clientId: d.clientId.toString(),
      templateId: d.templateId.toString(),
      templateName: d.templateName,
      fields: d.fields as RecordField[],
      values: this.crypto.decryptJson<RecordValues>(d.payload),
      appointmentId: d.appointmentId?.toString() ?? null,
      professionalId: d.professionalId?.toString() ?? null,
      authorUserId: d.authorUserId.toString(),
      status: d.status,
      signedAt: d.signedAt,
      createdAt: (d as unknown as { createdAt: Date }).createdAt,
      updatedAt: (d as unknown as { updatedAt: Date }).updatedAt,
      addenda: d.addenda.map((a) => ({ text: this.crypto.decrypt(a.payload), at: a.at, byUserId: a.byUserId.toString() })),
      canEdit: d.status === 'draft' && d.authorUserId.toString() === me,
    };
  }
}
