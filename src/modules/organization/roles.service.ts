import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AuditService } from '../../core/audit/audit.service.js';
import { isScopeAllowed, PERMISSIONS } from '../../core/authorization/permissions.catalog.js';
import { Errors } from '../../core/common/errors.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { EntitlementsService } from '../platform/entitlements.service.js';
import type { CreateRoleDto, RolePermissionDto, UpdateRoleDto } from './dto/role.dto.js';
import { Membership } from './schemas/membership.schema.js';
import { Role, type RoleDocument } from './schemas/role.schema.js';

@Injectable()
export class RolesService {
  constructor(
    @InjectModel(Role.name) private readonly roles: Model<Role>,
    @InjectModel(Membership.name) private readonly memberships: Model<Membership>,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  list(): Promise<RoleDocument[]> {
    return this.roles.find().sort({ createdAt: 1 }).exec();
  }

  async get(id: string): Promise<RoleDocument> {
    const role = await this.roles.findById(id).exec();
    if (!role) throw Errors.notFound('Rol');
    return role;
  }

  /** Crear roles nuevos requiere `custom_roles` en el plan. */
  async create(dto: CreateRoleDto): Promise<RoleDocument> {
    await this.entitlements.assertFeature(TenantContext.requireOrganizationId(), 'custom_roles');
    await this.assertNameFree(dto.name);
    const role = await this.roles.create({
      name: dto.name,
      description: dto.description,
      permissions: normalizePermissions(dto.permissions),
    });
    await this.audit.log({ action: 'role.created', entityType: 'Role', entityId: role.id as string });
    return role;
  }

  /** Editar permisos de un rol también requiere `custom_roles`. */
  async update(id: string, dto: UpdateRoleDto): Promise<RoleDocument> {
    const role = await this.get(id);
    if (role.isLocked) throw Errors.forbidden('Este rol no se puede modificar');
    if (dto.permissions) {
      await this.entitlements.assertFeature(TenantContext.requireOrganizationId(), 'custom_roles');
      role.permissions = normalizePermissions(dto.permissions);
    }
    if (dto.name && dto.name !== role.name) {
      await this.assertNameFree(dto.name);
      role.name = dto.name;
    }
    if (dto.description !== undefined) role.description = dto.description;
    await role.save();
    await this.audit.log({
      action: 'role.updated',
      entityType: 'Role',
      entityId: role.id as string,
      metadata: { fields: Object.keys(dto) },
    });
    return role;
  }

  async remove(id: string): Promise<void> {
    const role = await this.get(id);
    if (role.isLocked) throw Errors.forbidden('Este rol no se puede eliminar');
    if (await this.memberships.exists({ roleIds: role._id })) {
      throw Errors.conflict('ROLE_IN_USE', 'Hay miembros con este rol. Reasígnalos antes de eliminarlo.');
    }
    await role.deleteOne();
    await this.audit.log({ action: 'role.deleted', entityType: 'Role', entityId: id });
  }

  private async assertNameFree(name: string): Promise<void> {
    if (await this.roles.exists({ name })) {
      throw Errors.conflict('ROLE_NAME_TAKEN', 'Ya existe un rol con ese nombre');
    }
  }
}

function normalizePermissions(input: RolePermissionDto[]): RolePermissionDto[] {
  const byKey = new Map<string, RolePermissionDto>();
  for (const p of input) {
    if (!isScopeAllowed(p.key, p.scope)) {
      throw Errors.badRequest(
        'INVALID_SCOPE',
        `El permiso "${PERMISSIONS[p.key].label}" no admite el alcance "${p.scope}"`,
        { key: p.key, scope: p.scope },
      );
    }
    byKey.set(p.key, p);
  }
  return [...byKey.values()];
}
