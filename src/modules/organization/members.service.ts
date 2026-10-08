import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AuditService } from '../../core/audit/audit.service.js';
import { OWNER_ROLE_KEY } from '../../core/authorization/permissions.catalog.js';
import { Errors } from '../../core/common/errors.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { User } from '../identity/schemas/user.schema.js';
import type { UpdateMemberDto } from './dto/role.dto.js';
import { Branch } from './schemas/branch.schema.js';
import { Membership, type MembershipDocument } from './schemas/membership.schema.js';
import { Role } from './schemas/role.schema.js';

/**
 * Staff del negocio. La invitación de miembros nuevos llega con el módulo
 * de notificaciones (necesita enviar email).
 */
@Injectable()
export class MembersService {
  constructor(
    @InjectModel(Membership.name) private readonly memberships: Model<Membership>,
    @InjectModel(Role.name) private readonly roles: Model<Role>,
    @InjectModel(Branch.name) private readonly branches: Model<Branch>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const memberships = await this.memberships.find().sort({ createdAt: 1 }).exec();
    const users = await this.users
      .find({ _id: { $in: memberships.map((m) => m.userId) } })
      .select('firstName lastName email phone')
      .exec();
    const userById = new Map(users.map((u) => [u.id as string, u]));
    return memberships.map((m) => ({ ...m.toJSON(), user: userById.get(m.userId.toString()) ?? null }));
  }

  async update(id: string, dto: UpdateMemberDto): Promise<MembershipDocument> {
    const membership = await this.memberships.findById(id).exec();
    if (!membership) throw Errors.notFound('Miembro');
    if (dto.status === 'suspended' && membership.id === TenantContext.getAccess()?.membershipId) {
      throw Errors.conflict('SELF_SUSPEND', 'No puedes suspender tu propio acceso');
    }

    const ownerRole = await this.roles.findOne({ templateKey: OWNER_ROLE_KEY }).exec();
    const wasOwner = !!ownerRole && membership.roleIds.some((r) => r.equals(ownerRole._id));

    if (dto.roleIds) {
      const found = await this.roles.countDocuments({ _id: { $in: dto.roleIds } }).exec();
      if (found !== dto.roleIds.length) throw Errors.badRequest('INVALID_ROLE', 'Rol inválido');
    }
    if (dto.branchIds?.length) {
      const found = await this.branches.countDocuments({ _id: { $in: dto.branchIds } }).exec();
      if (found !== dto.branchIds.length) throw Errors.badRequest('INVALID_BRANCH', 'Sucursal inválida');
    }

    const losesOwner =
      wasOwner &&
      ((dto.roleIds && !dto.roleIds.includes(ownerRole._id.toString())) || dto.status === 'suspended');
    if (losesOwner && ownerRole) {
      const owners = await this.memberships
        .countDocuments({ roleIds: ownerRole._id, status: 'active' })
        .exec();
      if (owners <= 1) {
        throw Errors.conflict('LAST_OWNER', 'El negocio debe tener al menos un Dueño activo');
      }
    }

    membership.set(dto);
    await membership.save();
    await this.audit.log({
      action: 'member.updated',
      entityType: 'Membership',
      entityId: id,
      metadata: { ...dto },
    });
    return membership;
  }
}
