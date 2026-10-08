import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model, type PipelineStage, type QueryFilter } from 'mongoose';
import { AuditService } from '../../core/audit/audit.service.js';
import type { PermissionKey } from '../../core/authorization/permissions.catalog.js';
import { currentScope } from '../../core/authorization/scope.js';
import { AppError, Errors } from '../../core/common/errors.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { Appointment } from '../bookings/schemas/appointment.schema.js';
import { Professional } from '../professionals/schemas/professional.schema.js';
import type { ClientSegment, CreateClientDto, UpdateClientDto } from './dto/client.dto.js';
import { Client, normalizeSearch, type ClientDocument } from './schemas/client.schema.js';

/** "987 654 321" / "+51987654321" → "+51987654321". */
export function normalizePhone(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  return `+51${digits.slice(-9)}`;
}

/** "4567 8901" / "ce-001234567" → "45678901" / "CE001234567". Vacío = sin documento. */
export function normalizeDocument(documentId: string | undefined | null): string | undefined {
  const value = documentId?.replace(/[\s.\-]/g, '').toUpperCase();
  return value || undefined;
}

const DUPLICATE_KEY = 11000;
const DAY = 86_400_000;
/** Sin venir en este tiempo y sin cita próxima = cliente en riesgo. */
export const AT_RISK_DAYS = 45;
/** Registrado hace menos de esto = cliente nuevo. */
export const NEW_DAYS = 30;

export interface ClientStats {
  visits: number;
  spent: number;
  noShows: number;
  lastVisit: Date | null;
  nextAppointment: Date | null;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class ClientsService {
  constructor(
    @InjectModel(Client.name) private readonly clients: Model<Client>,
    @InjectModel(Appointment.name) private readonly appointments: Model<Appointment>,
    @InjectModel(Professional.name) private readonly professionals: Model<Professional>,
    private readonly audit: AuditService,
  ) {}

  /** Búsqueda rápida (selector de clientes al agendar). */
  async list(search?: string, limit = 25): Promise<ClientDocument[]> {
    return this.clients
      .find({ ...(await this.scopeFilter('client.read')), ...this.searchFilter(search) })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .exec();
  }

  /** Lista con estadísticas, segmentos y paginación (pantalla Clientes). */
  async directory(opts: { search?: string; segment?: ClientSegment; page?: number; limit?: number }) {
    const page = opts.page ?? 1;
    const limit = opts.limit ?? 25;
    const now = new Date();
    const sort: Record<string, 1 | -1> =
      opts.segment === 'upcoming' ? { 'stats.nextAppointment': 1 } : opts.segment === 'at_risk' ? { 'stats.lastVisit': 1 } : { createdAt: -1 };

    const [result] = await this.clients
      .aggregate<{ items: Array<Client & { _id: Types.ObjectId; stats: ClientStats }>; total: Array<{ n: number }> }>([
        ...(await this.withStats(opts.search, now)),
        ...(opts.segment && opts.segment !== 'all' ? [{ $match: this.segmentMatch(opts.segment, now) }] : []),
        { $sort: { ...sort, _id: -1 } },
        { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'n' }] } },
      ])
      .exec();

    return {
      items: (result?.items ?? []).map(({ _id, searchText: _s, organizationId: _o, ...c }) => ({ id: _id.toString(), ...c })),
      total: result?.total[0]?.n ?? 0,
      page,
      pageSize: limit,
    };
  }

  /** KPIs de la pantalla Clientes. */
  async summary() {
    const now = new Date();
    const counts = (seg: ClientSegment) => ({ $sum: { $cond: [this.segmentExpr(seg, now), 1, 0] } });
    const [res] = await this.clients
      .aggregate<{ total: number; new: number; upcoming: number; atRisk: number; vip: number }>([
        ...(await this.withStats(undefined, now)),
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            new: counts('new'),
            upcoming: counts('upcoming'),
            atRisk: counts('at_risk'),
            vip: counts('vip'),
          },
        },
      ])
      .exec();
    return { total: res?.total ?? 0, new: res?.new ?? 0, upcoming: res?.upcoming ?? 0, atRisk: res?.atRisk ?? 0, vip: res?.vip ?? 0 };
  }

  async get(id: string): Promise<ClientDocument> {
    const client = await this.clients.findOne({ _id: id, ...(await this.scopeFilter('client.read')) }).exec();
    if (!client) throw Errors.notFound('Cliente');
    return client;
  }

  async create(dto: CreateClientDto): Promise<ClientDocument> {
    const doc = this.toDoc(dto);
    await this.assertUnique(doc, dto.allowSharedPhone);
    try {
      const client = await this.clients.create(doc);
      await this.audit.log({ action: 'client.created', entityType: 'Client', entityId: client.id as string });
      return client;
    } catch (error) {
      throw await this.duplicateError(error, doc);
    }
  }

  async update(id: string, dto: UpdateClientDto): Promise<ClientDocument> {
    const client = await this.clients.findOne({ _id: id, ...(await this.scopeFilter('client.update')) }).exec();
    if (!client) throw Errors.notFound('Cliente');
    const doc = this.toDoc(dto);
    // No reescribir la fecha de un consentimiento ya otorgado.
    if (dto.dataConsent === true && client.dataConsentAt) delete doc.dataConsentAt;
    // Solo se avisa del celular si cambia.
    await this.assertUnique(doc, dto.allowSharedPhone || doc.phone === client.phone, id);
    client.set(doc);
    try {
      await client.save();
    } catch (error) {
      throw await this.duplicateError(error, doc);
    }
    await this.audit.log({ action: 'client.updated', entityType: 'Client', entityId: id, metadata: { fields: Object.keys(dto) } });
    return client;
  }

  /* ---------- Internos ---------- */

  /**
   * DNI repetido: se bloquea. Celular repetido: se avisa con quién lo tiene
   * y se permite si confirman que es otra persona.
   */
  private async assertUnique(doc: Record<string, unknown>, allowSharedPhone = false, exceptId?: string): Promise<void> {
    const others = exceptId ? { _id: { $ne: exceptId } } : {};
    if (typeof doc.documentId === 'string') {
      const owner = await this.clients.findOne({ ...others, documentId: doc.documentId }).exec();
      if (owner) throw this.takenError('CLIENT_DOCUMENT_TAKEN', `El documento ${doc.documentId} ya es de`, owner);
    }
    if (typeof doc.phone === 'string' && !allowSharedPhone) {
      const owner = await this.clients.findOne({ ...others, phone: doc.phone }).exec();
      if (owner) throw this.takenError('CLIENT_PHONE_TAKEN', 'Ese celular ya es de', owner);
    }
  }

  private takenError(code: string, prefix: string, owner: ClientDocument): AppError {
    const name = `${owner.firstName} ${owner.lastName}`.trim();
    return new AppError(HttpStatus.CONFLICT, code, `${prefix} ${name}`, { clientId: owner.id as string, name });
  }

  /** Dos registros simultáneos con el mismo DNI: el índice único decide. */
  private async duplicateError(error: unknown, doc: Record<string, unknown>): Promise<unknown> {
    if ((error as { code?: number }).code !== DUPLICATE_KEY) return error;
    const owner = await this.clients.findOne({ documentId: doc.documentId as string }).exec();
    return owner
      ? this.takenError('CLIENT_DOCUMENT_TAKEN', `El documento ${String(doc.documentId)} ya es de`, owner)
      : Errors.conflict('CLIENT_DOCUMENT_TAKEN', 'Ese documento ya está registrado');
  }

  private toDoc(dto: CreateClientDto | UpdateClientDto): Record<string, unknown> {
    const { dataConsent, phone, documentId, allowSharedPhone: _confirm, ...rest } = dto;
    return {
      ...rest,
      ...(phone !== undefined && { phone: normalizePhone(phone) }),
      ...(documentId !== undefined && { documentId: normalizeDocument(documentId) }),
      ...(dataConsent !== undefined && { dataConsentAt: dataConsent ? new Date() : null }),
    };
  }

  private searchFilter(search?: string): QueryFilter<Client> {
    const term = search?.trim();
    if (!term) return {};
    const digits = term.replace(/\D/g, '');
    return {
      $or: [
        { searchText: { $regex: escapeRegex(normalizeSearch(term)) } },
        ...(digits.length >= 3 ? [{ phone: { $regex: digits } }] : []),
      ],
    };
  }

  /** Clientes con sus estadísticas de citas (el plugin de tenant filtra el $match inicial). */
  private async withStats(search: string | undefined, now: Date): Promise<PipelineStage[]> {
    const orgId = new Types.ObjectId(TenantContext.requireOrganizationId());
    return [
      { $match: { ...(await this.scopeFilter('client.read')), ...this.searchFilter(search) } as never },
      {
        $lookup: {
          from: 'appointments',
          let: { cid: '$_id' },
          pipeline: [
            // $lookup no pasa por el plugin de tenant: se filtra la organización a mano.
            { $match: { $expr: { $and: [{ $eq: ['$clientId', '$$cid'] }, { $eq: ['$organizationId', orgId] }] } } },
            {
              $group: {
                _id: null,
                visits: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
                spent: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$price', 0] } },
                noShows: { $sum: { $cond: [{ $eq: ['$status', 'no_show'] }, 1, 0] } },
                lastVisit: { $max: { $cond: [{ $eq: ['$status', 'completed'] }, '$startsAt', null] } },
                nextAppointment: {
                  $min: {
                    $cond: [
                      { $and: [{ $gte: ['$startsAt', now] }, { $in: ['$status', ['pending', 'confirmed']] }] },
                      '$startsAt',
                      null,
                    ],
                  },
                },
              },
            },
          ],
          as: 'stats',
        },
      },
      {
        $set: {
          stats: {
            $ifNull: [{ $first: '$stats' }, { visits: 0, spent: 0, noShows: 0, lastVisit: null, nextAppointment: null }],
          },
        },
      },
      { $unset: ['stats._id'] },
    ];
  }

  private segmentExpr(segment: ClientSegment, now: Date): unknown {
    switch (segment) {
      case 'new':
        return { $gte: ['$createdAt', new Date(now.getTime() - NEW_DAYS * DAY)] };
      case 'upcoming':
        return { $ne: [{ $ifNull: ['$stats.nextAppointment', null] }, null] };
      case 'at_risk':
        return {
          $and: [
            { $ne: [{ $ifNull: ['$stats.lastVisit', null] }, null] },
            { $lt: ['$stats.lastVisit', new Date(now.getTime() - AT_RISK_DAYS * DAY)] },
            { $eq: [{ $ifNull: ['$stats.nextAppointment', null] }, null] },
          ],
        };
      case 'vip':
        return { $in: ['vip', { $map: { input: '$tags', as: 't', in: { $toLower: '$$t' } } }] };
      default:
        return true;
    }
  }

  private segmentMatch(segment: ClientSegment, now: Date) {
    return { $expr: this.segmentExpr(segment, now) };
  }

  /** Alcance "propio": solo los clientes que atendió (tienen citas con su perfil). */
  private async scopeFilter(permission: PermissionKey): Promise<QueryFilter<Client>> {
    const scope = currentScope(permission);
    if (!scope) throw Errors.forbidden();
    if (scope !== 'own') return {};
    const access = TenantContext.getAccess()!;
    const mine = await this.professionals.find({ membershipId: access.membershipId }).select('_id').exec();
    const clientIds = await this.appointments.distinct('clientId', { professionalId: { $in: mine.map((p) => p._id) } }).exec();
    return { _id: { $in: clientIds } };
  }
}
