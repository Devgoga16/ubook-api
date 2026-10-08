import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AuditService } from '../../core/audit/audit.service.js';
import { Errors } from '../../core/common/errors.js';
import { normalizeDays, validateDays, type DaySchedule } from '../../core/scheduling/weekly-schedule.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import type {
  CreateBranchExceptionDto,
  UpdateBookingRulesDto,
} from './dto/availability.dto.js';
import { BranchException, type BranchExceptionDocument } from './schemas/branch-exception.schema.js';
import { Branch, type BranchDocument } from './schemas/branch.schema.js';
import { Organization, type BookingRules } from './schemas/organization.schema.js';

const DUPLICATE_KEY = 11000;

/** Horario de atención de sedes, feriados/excepciones y reglas de reserva. */
@Injectable()
export class AvailabilitySettingsService {
  constructor(
    @InjectModel(Branch.name) private readonly branches: Model<Branch>,
    @InjectModel(BranchException.name) private readonly exceptions: Model<BranchException>,
    @InjectModel(Organization.name) private readonly organizations: Model<Organization>,
    private readonly audit: AuditService,
  ) {}

  /* ---------- Horario de atención ---------- */

  async setOpeningHours(branchId: string, days: DaySchedule[]): Promise<BranchDocument> {
    const branch = await this.findBranch(branchId);
    const problem = validateDays(days);
    if (problem) throw Errors.badRequest('INVALID_SCHEDULE', problem);
    branch.openingHours = normalizeDays(days) as never;
    await branch.save();
    await this.audit.log({ action: 'branch.hours_updated', entityType: 'Branch', entityId: branchId });
    return branch;
  }

  async copyOpeningHours(fromId: string, toId: string): Promise<BranchDocument> {
    if (fromId === toId) throw Errors.badRequest('SAME_BRANCH', 'Elige otra sucursal');
    const from = await this.findBranch(fromId);
    return this.setOpeningHours(
      toId,
      from.openingHours.map((d) => ({ weekday: d.weekday, intervals: d.intervals.map((r) => ({ ...r })) })),
    );
  }

  /* ---------- Feriados y excepciones ---------- */

  async listExceptions(branchId: string, from?: string, to?: string): Promise<BranchExceptionDocument[]> {
    await this.findBranch(branchId);
    const date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
    return this.exceptions
      .find({ branchId, ...(Object.keys(date).length && { date }) })
      .sort({ date: 1 })
      .exec();
  }

  async createException(branchId: string, dto: CreateBranchExceptionDto): Promise<BranchExceptionDocument> {
    await this.findBranch(branchId);
    const intervals = this.validateException(dto);
    try {
      const created = await this.exceptions.create({ ...dto, branchId, intervals });
      await this.audit.log({
        action: 'branch.exception_created',
        entityType: 'BranchException',
        entityId: created.id as string,
        metadata: { date: dto.date },
      });
      return created;
    } catch (error) {
      if ((error as { code?: number }).code === DUPLICATE_KEY) {
        throw Errors.conflict('EXCEPTION_EXISTS', 'Ya hay una excepción registrada para ese día');
      }
      throw error;
    }
  }

  /** Crea varias de una vez; las fechas que ya existen se omiten. */
  async createExceptions(branchId: string, items: CreateBranchExceptionDto[]): Promise<{ created: number; skipped: number }> {
    await this.findBranch(branchId);
    const existing = new Set(
      (await this.exceptions.find({ branchId, date: { $in: items.map((i) => i.date) } }).select('date').exec()).map(
        (e) => e.date,
      ),
    );
    const fresh = items.filter((i, idx) => !existing.has(i.date) && items.findIndex((x) => x.date === i.date) === idx);
    for (const item of fresh) {
      await this.exceptions.create({ ...item, branchId, intervals: this.validateException(item) });
    }
    if (fresh.length) {
      await this.audit.log({ action: 'branch.exceptions_imported', entityType: 'Branch', entityId: branchId, metadata: { count: fresh.length } });
    }
    return { created: fresh.length, skipped: items.length - fresh.length };
  }

  async removeException(id: string): Promise<void> {
    const entry = await this.exceptions.findById(id).exec();
    if (!entry) throw Errors.notFound('Excepción');
    await entry.deleteOne();
    await this.audit.log({ action: 'branch.exception_deleted', entityType: 'BranchException', entityId: id });
  }

  /* ---------- Reglas de reserva ---------- */

  async getRules(): Promise<BookingRules> {
    const org = await this.organizations.findById(TenantContext.requireOrganizationId()).select('bookingRules').exec();
    if (!org) throw Errors.notFound('Negocio');
    return org.toObject().bookingRules;
  }

  async updateRules(dto: UpdateBookingRulesDto): Promise<BookingRules> {
    const org = await this.organizations.findById(TenantContext.requireOrganizationId()).exec();
    if (!org) throw Errors.notFound('Negocio');
    for (const [key, value] of Object.entries(dto)) org.set(`bookingRules.${key}`, value);
    await org.save();
    await this.audit.log({ action: 'booking_rules.updated', entityType: 'Organization', entityId: org.id as string, metadata: { ...dto } });
    return org.toObject().bookingRules;
  }

  /* ---------- Internos ---------- */

  private async findBranch(id: string): Promise<BranchDocument> {
    const branch = await this.branches.findById(id).exec();
    if (!branch) throw Errors.notFound('Sucursal');
    return branch;
  }

  private validateException(dto: CreateBranchExceptionDto) {
    if (dto.type === 'closed') return [];
    const intervals = dto.intervals ?? [];
    const problem = validateDays([{ weekday: 1, intervals }]);
    if (problem) throw Errors.badRequest('INVALID_SCHEDULE', problem);
    return [...intervals].sort((a, b) => a.start - b.start);
  }
}
