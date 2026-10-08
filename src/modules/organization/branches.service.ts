import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { AuditService } from '../../core/audit/audit.service.js';
import { AppError, Errors } from '../../core/common/errors.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { EntitlementsService } from '../platform/entitlements.service.js';
import type { CreateBranchDto, UpdateBranchDto } from './dto/branch.dto.js';
import { Branch, type BranchDocument } from './schemas/branch.schema.js';
import { Organization } from './schemas/organization.schema.js';

@Injectable()
export class BranchesService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Branch.name) private readonly branches: Model<Branch>,
    @InjectModel(Organization.name) private readonly organizations: Model<Organization>,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  list(): Promise<BranchDocument[]> {
    return this.branches.find().sort({ createdAt: 1 }).exec();
  }

  async create(dto: CreateBranchDto): Promise<BranchDocument> {
    const organizationId = TenantContext.requireOrganizationId();
    const activeCount = await this.branches.countDocuments({ isActive: true }).exec();
    await this.entitlements.assertWithinLimit(organizationId, 'max_branches', activeCount);

    const timezone =
      dto.timezone ?? (await this.organizations.findById(organizationId).select('timezone').exec())!.timezone;
    const branch = await this.branches.create({ ...dto, timezone });
    await this.audit.log({ action: 'branch.created', entityType: 'Branch', entityId: branch.id as string });
    return branch;
  }

  async update(id: string, dto: UpdateBranchDto): Promise<BranchDocument> {
    const branch = await this.branches.findById(id).exec();
    if (!branch) throw Errors.notFound('Sucursal');

    if (dto.isActive === true && !branch.isActive) {
      const activeCount = await this.branches.countDocuments({ isActive: true }).exec();
      await this.entitlements.assertWithinLimit(
        TenantContext.requireOrganizationId(),
        'max_branches',
        activeCount,
      );
    }
    if (dto.isActive === false && branch.isActive) {
      if ((await this.branches.countDocuments({ isActive: true }).exec()) <= 1) {
        throw Errors.conflict('LAST_BRANCH', 'El negocio debe tener al menos una sucursal activa');
      }
      // Las citas viven en otro módulo: se consultan por la colección.
      const upcoming = await this.connection.collection('appointments').countDocuments({
        organizationId: branch.organizationId,
        branchId: branch._id,
        status: { $in: ['pending', 'confirmed'] },
        startsAt: { $gt: new Date() },
      });
      if (upcoming > 0) {
        throw new AppError(
          HttpStatus.CONFLICT,
          'BRANCH_HAS_APPOINTMENTS',
          `Esta sede tiene ${upcoming} ${upcoming === 1 ? 'cita próxima' : 'citas próximas'}. Muévelas o cancélalas antes de desactivarla.`,
          { upcoming },
        );
      }
    }

    branch.set(dto);
    await branch.save();
    await this.audit.log({
      action: 'branch.updated',
      entityType: 'Branch',
      entityId: id,
      metadata: { fields: Object.keys(dto) },
    });
    return branch;
  }
}
