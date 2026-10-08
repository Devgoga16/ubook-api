import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { StaffAccess } from '../../core/authorization/access.types.js';
import {
  broaderScope,
  OWNER_ROLE_KEY,
  PERMISSION_KEYS,
  type PermissionKey,
  type Scope,
} from '../../core/authorization/permissions.catalog.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { Membership, type MembershipDocument } from './schemas/membership.schema.js';
import { Organization } from './schemas/organization.schema.js';
import { Role } from './schemas/role.schema.js';

export interface UserOrganizationSummary {
  organizationId: string;
  membershipId: string;
  name: string;
  slug: string;
  roles: string[];
}

@Injectable()
export class AccessControlService {
  constructor(
    @InjectModel(Membership.name) private readonly memberships: Model<Membership>,
    @InjectModel(Role.name) private readonly roles: Model<Role>,
    @InjectModel(Organization.name) private readonly organizations: Model<Organization>,
  ) {}

  /**
   * Permisos efectivos de una membresía en la organización en contexto.
   * Si un permiso aparece en varios roles, gana el alcance más amplio.
   * El Dueño recibe siempre el catálogo completo (incluye permisos futuros).
   */
  async resolveStaffAccess(membershipId: string): Promise<StaffAccess | null> {
    const membership = await this.memberships.findOne({ _id: membershipId, status: 'active' }).exec();
    if (!membership) return null;

    const roles = await this.roles.find({ _id: { $in: membership.roleIds } }).exec();
    const isOwner = roles.some((r) => r.templateKey === OWNER_ROLE_KEY);

    const permissions: Partial<Record<PermissionKey, Scope>> = {};
    if (isOwner) {
      for (const key of PERMISSION_KEYS) permissions[key] = 'organization';
    } else {
      for (const role of roles) {
        for (const { key, scope } of role.permissions) {
          permissions[key] = permissions[key] ? broaderScope(permissions[key], scope) : scope;
        }
      }
    }

    return {
      membershipId: membership.id as string,
      userId: membership.userId.toString(),
      organizationId: membership.organizationId.toString(),
      isOwner,
      branchIds: membership.branchIds.map(String),
      permissions,
    };
  }

  /** Busca la membresía activa del usuario en una organización. */
  findActiveMembership(userId: string, organizationId: string): Promise<MembershipDocument | null> {
    return TenantContext.runForOrganization(organizationId, () =>
      this.memberships.findOne({ userId, status: 'active' }).exec(),
    );
  }

  /** Negocios donde el usuario es staff (para el selector de organización). */
  listUserOrganizations(userId: string): Promise<UserOrganizationSummary[]> {
    return TenantContext.runAsSystem(async () => {
      const memberships = await this.memberships.find({ userId, status: 'active' }).exec();
      if (memberships.length === 0) return [];

      const [orgs, roles] = await Promise.all([
        this.organizations
          .find({ _id: { $in: memberships.map((m) => m.organizationId) }, status: 'active' })
          .exec(),
        this.roles.find({ _id: { $in: memberships.flatMap((m) => m.roleIds) } }).exec(),
      ]);
      const orgById = new Map(orgs.map((o) => [o.id as string, o]));
      const roleName = new Map(roles.map((r) => [r.id as string, r.name]));

      return memberships.flatMap((m) => {
        const org = orgById.get(m.organizationId.toString());
        if (!org) return [];
        return [
          {
            organizationId: org.id as string,
            membershipId: m.id as string,
            name: org.name,
            slug: org.slug,
            roles: m.roleIds.map((id) => roleName.get(id.toString()) ?? ''),
          },
        ];
      });
    });
  }
}
