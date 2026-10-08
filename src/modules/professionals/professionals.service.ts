import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter } from 'mongoose';
import { AuditService } from '../../core/audit/audit.service.js';
import { assertCanActOn, canActOn, currentScope, type ScopedTarget } from '../../core/authorization/scope.js';
import { Errors } from '../../core/common/errors.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { Service } from '../catalog/schemas/service.schema.js';
import { Branch } from '../organization/schemas/branch.schema.js';
import { Membership } from '../organization/schemas/membership.schema.js';
import { EntitlementsService } from '../platform/entitlements.service.js';
import type {
  CreateProfessionalDto,
  CreateTimeOffDto,
  SetScheduleDto,
  UpdateProfessionalDto,
} from './dto/professional.dto.js';
import { findCrossBranchOverlap, normalizeDays, validateDays, WEEKDAY_NAMES } from '../../core/scheduling/weekly-schedule.js';
import { Professional, type ProfessionalDocument } from './schemas/professional.schema.js';
import { TimeOff, type TimeOffDocument } from './schemas/time-off.schema.js';

const MAX_TIME_OFF_DAYS = 366;

function targetOf(p: ProfessionalDocument): ScopedTarget {
  return { ownerMembershipId: p.membershipId?.toString() ?? null, branchIds: p.branchIds.map(String) };
}

@Injectable()
export class ProfessionalsService {
  constructor(
    @InjectModel(Professional.name) private readonly professionals: Model<Professional>,
    @InjectModel(TimeOff.name) private readonly timeOff: Model<TimeOff>,
    @InjectModel(Branch.name) private readonly branches: Model<Branch>,
    @InjectModel(Service.name) private readonly services: Model<Service>,
    @InjectModel(Membership.name) private readonly memberships: Model<Membership>,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  /* ---------- Perfil ---------- */

  /**
   * Con alcance de sucursal, solo los de sus sedes. Sin `professional.read`
   * pero con `schedule.read` (p. ej. el rol Profesional), solo su propio perfil:
   * lo necesita la agenda para mostrar su columna.
   */
  list(): Promise<ProfessionalDocument[]> {
    const access = TenantContext.getAccess();
    const filter: QueryFilter<Professional> = {};
    const scope = currentScope('professional.read');
    if (!scope) {
      if (!currentScope('schedule.read') || !access) throw Errors.forbidden();
      filter.membershipId = access.membershipId;
    } else if (scope === 'branch' && access?.branchIds.length) {
      filter.branchIds = { $in: access.branchIds };
    }
    return this.professionals.find(filter).sort({ sortOrder: 1, displayName: 1 }).exec();
  }

  /** Lo puede ver quien tiene `professional.read` sobre él o el propio profesional. */
  async get(id: string): Promise<ProfessionalDocument> {
    const p = await this.find(id);
    if (!canActOn('professional.read', targetOf(p)) && !canActOn('schedule.read', targetOf(p))) {
      throw Errors.forbidden();
    }
    return p;
  }

  async create(dto: CreateProfessionalDto): Promise<ProfessionalDocument> {
    assertCanActOn('professional.manage', { branchIds: dto.branchIds });
    await this.assertWithinLimit();
    await this.validateRefs(dto, null);

    const professional = await this.professionals.create({
      ...dto,
      services: (dto.services ?? []).map((s) => ({ price: null, durationMinutes: null, ...s })),
    });
    await this.audit.log({
      action: 'professional.created',
      entityType: 'Professional',
      entityId: professional.id as string,
    });
    return professional;
  }

  async update(id: string, dto: UpdateProfessionalDto): Promise<ProfessionalDocument> {
    const p = await this.find(id);
    assertCanActOn('professional.manage', targetOf(p));
    if (dto.branchIds) assertCanActOn('professional.manage', { branchIds: dto.branchIds });
    if (dto.isActive === true && !p.isActive) await this.assertWithinLimit();
    await this.validateRefs(dto, p);

    const { services, ...rest } = dto;
    p.set(rest);
    if (services) p.services = services.map((s) => ({ price: null, durationMinutes: null, ...s })) as never;
    // Al quitar una sede, su horario deja de tener sentido.
    if (dto.branchIds) {
      p.schedules = p.schedules.filter((s) => dto.branchIds!.includes(s.branchId.toString()));
    }
    await p.save();
    await this.audit.log({
      action: 'professional.updated',
      entityType: 'Professional',
      entityId: id,
      metadata: { fields: Object.keys(dto) },
    });
    return p;
  }

  /* ---------- Horario ---------- */

  async setSchedule(id: string, dto: SetScheduleDto): Promise<ProfessionalDocument> {
    const p = await this.find(id);
    assertCanActOn('schedule.manage', targetOf(p));
    if (!p.branchIds.some((b) => b.toString() === dto.branchId)) {
      throw Errors.badRequest('BRANCH_NOT_ASSIGNED', 'El profesional no trabaja en esa sede');
    }
    const problem = validateDays(dto.days);
    if (problem) throw Errors.badRequest('INVALID_SCHEDULE', problem);

    const days = normalizeDays(dto.days);
    const others = p.schedules
      .filter((s) => s.branchId.toString() !== dto.branchId)
      .map((s) => ({ branchId: s.branchId.toString(), days: s.days }));
    const clash = findCrossBranchOverlap([...others, { branchId: dto.branchId, days }]);
    if (clash) {
      throw Errors.badRequest(
        'SCHEDULE_OVERLAP',
        `El ${WEEKDAY_NAMES[clash.weekday]} ya trabaja en otra sede a esa hora`,
        { weekday: clash.weekday },
      );
    }

    p.schedules = [...others, { branchId: dto.branchId, days }] as never;
    await p.save();
    await this.audit.log({
      action: 'professional.schedule_updated',
      entityType: 'Professional',
      entityId: id,
      metadata: { branchId: dto.branchId },
    });
    return p;
  }

  /* ---------- Ausencias ---------- */

  async listTimeOff(professionalId: string, from?: Date, to?: Date): Promise<TimeOffDocument[]> {
    const p = await this.find(professionalId);
    if (!canActOn('schedule.read', targetOf(p)) && !canActOn('professional.read', targetOf(p))) {
      throw Errors.forbidden();
    }
    return this.timeOff
      .find({
        professionalId: p._id,
        ...(to && { startsAt: { $lt: to } }),
        ...(from && { endsAt: { $gt: from } }),
      })
      .sort({ startsAt: 1 })
      .exec();
  }

  /**
   * Quien gestiona la sede o el negocio la registra aprobada; si la pide
   * el propio profesional, queda pendiente de aprobación.
   */
  async createTimeOff(professionalId: string, dto: CreateTimeOffDto): Promise<TimeOffDocument> {
    const p = await this.find(professionalId);
    assertCanActOn('schedule.manage', targetOf(p));
    if (dto.endsAt <= dto.startsAt) throw Errors.badRequest('INVALID_RANGE', 'La fecha de fin debe ser posterior al inicio');
    if (dto.endsAt.getTime() - dto.startsAt.getTime() > MAX_TIME_OFF_DAYS * 86_400_000) {
      throw Errors.badRequest('INVALID_RANGE', 'Una ausencia no puede durar más de un año');
    }

    const manager = this.isManagerOf(p);
    const userId = TenantContext.getActor()?.userId;
    const entry = await this.timeOff.create({
      ...dto,
      professionalId: p._id,
      status: manager ? 'approved' : 'pending',
      requestedBy: userId,
      ...(manager && { decidedBy: userId, decidedAt: new Date() }),
    });
    await this.audit.log({ action: 'time_off.created', entityType: 'TimeOff', entityId: entry.id as string });
    return entry;
  }

  /** Aprobar o rechazar. El propio profesional no puede aprobarse. */
  async decideTimeOff(id: string, status: 'approved' | 'rejected'): Promise<TimeOffDocument> {
    const entry = await this.timeOff.findById(id).exec();
    if (!entry) throw Errors.notFound('Ausencia');
    const p = await this.find(entry.professionalId.toString());
    if (!this.isManagerOf(p)) throw Errors.forbidden('Solo quien gestiona la sede puede aprobar ausencias');

    entry.status = status;
    entry.decidedBy = TenantContext.getActor()?.userId as never;
    entry.decidedAt = new Date();
    await entry.save();
    await this.audit.log({ action: `time_off.${status}`, entityType: 'TimeOff', entityId: id });
    return entry;
  }

  /** El profesional puede retirar su solicitud pendiente; quien gestiona, cualquiera. */
  async removeTimeOff(id: string): Promise<void> {
    const entry = await this.timeOff.findById(id).exec();
    if (!entry) throw Errors.notFound('Ausencia');
    const p = await this.find(entry.professionalId.toString());
    assertCanActOn('schedule.manage', targetOf(p));
    if (!this.isManagerOf(p) && entry.status !== 'pending') {
      throw Errors.forbidden('Solo puedes retirar solicitudes pendientes');
    }
    await entry.deleteOne();
    await this.audit.log({ action: 'time_off.deleted', entityType: 'TimeOff', entityId: id });
  }

  /* ---------- Internos ---------- */

  private async find(id: string): Promise<ProfessionalDocument> {
    const p = await this.professionals.findById(id).exec();
    if (!p) throw Errors.notFound('Profesional');
    return p;
  }

  /** Gestiona al profesional con alcance de sede o negocio (no solo "lo propio"). */
  private isManagerOf(p: ProfessionalDocument): boolean {
    const scope = currentScope('schedule.manage');
    return (scope === 'branch' || scope === 'organization') && canActOn('schedule.manage', targetOf(p));
  }

  private async assertWithinLimit(): Promise<void> {
    const active = await this.professionals.countDocuments({ isActive: true }).exec();
    await this.entitlements.assertWithinLimit(TenantContext.requireOrganizationId(), 'max_professionals', active);
  }

  private async validateRefs(
    dto: Pick<CreateProfessionalDto, 'branchIds' | 'services' | 'membershipId'> | UpdateProfessionalDto,
    current: ProfessionalDocument | null,
  ): Promise<void> {
    if (dto.branchIds) {
      if (dto.branchIds.length === 0) throw Errors.badRequest('BRANCH_REQUIRED', 'Elige al menos una sede');
      const found = await this.branches.countDocuments({ _id: { $in: dto.branchIds }, isActive: true }).exec();
      if (found !== dto.branchIds.length) throw Errors.badRequest('INVALID_BRANCH', 'Sucursal inválida');
    }
    if (dto.services?.length) {
      const ids = [...new Set(dto.services.map((s) => s.serviceId))];
      if (ids.length !== dto.services.length) throw Errors.badRequest('DUPLICATE_SERVICE', 'Hay servicios repetidos');
      const found = await this.services.countDocuments({ _id: { $in: ids }, isArchived: false }).exec();
      if (found !== ids.length) throw Errors.badRequest('INVALID_SERVICE', 'Servicio inválido o archivado');
    }
    if (dto.membershipId) {
      if (!(await this.memberships.exists({ _id: dto.membershipId }))) {
        throw Errors.badRequest('INVALID_MEMBER', 'El usuario no pertenece al negocio');
      }
      const taken = await this.professionals
        .exists({ membershipId: dto.membershipId, ...(current && { _id: { $ne: current._id } }) })
        .exec();
      if (taken) throw Errors.conflict('MEMBER_ALREADY_LINKED', 'Ese usuario ya está vinculado a otro profesional');
    }
  }
}
