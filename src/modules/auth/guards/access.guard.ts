import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  ALLOW_WHEN_READ_ONLY,
  REQUIRED_FEATURE,
  REQUIRED_PERMISSION,
} from '../../../core/auth/decorators.js';
import type { PermissionKey } from '../../../core/authorization/permissions.catalog.js';
import { Errors } from '../../../core/common/errors.js';
import { TenantContext } from '../../../core/tenancy/tenant-context.js';
import { AccessControlService } from '../../organization/access-control.service.js';
import { EntitlementsService } from '../../platform/entitlements.service.js';
import type { FeatureKey } from '../../platform/features.catalog.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Para sesiones de staff: membresía vigente, estado de la suscripción,
 * funcionalidad del plan y permiso del rol, en ese orden.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessControl: AccessControlService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const actor = TenantContext.getActor();
    if (actor?.ctx !== 'staff' || !actor.membershipId || !actor.organizationId) return true;

    const targets = [context.getHandler(), context.getClass()];
    const access = await this.accessControl.resolveStaffAccess(actor.membershipId);
    if (!access || access.userId !== actor.userId) {
      throw Errors.unauthorized('Tu acceso a este negocio fue revocado');
    }
    TenantContext.setAccess(access);

    const allowReadOnly = this.reflector.getAllAndOverride<boolean>(ALLOW_WHEN_READ_ONLY, targets);
    const entitlements = await this.entitlements.get(actor.organizationId);
    if (entitlements.suspended && !allowReadOnly) throw Errors.organizationSuspended();

    const method = context.switchToHttp().getRequest<Request>().method;
    if (entitlements.readOnly && !SAFE_METHODS.has(method) && !allowReadOnly) {
      throw Errors.subscriptionReadOnly();
    }

    const feature = this.reflector.getAllAndOverride<FeatureKey>(REQUIRED_FEATURE, targets);
    if (feature) await this.entitlements.assertFeature(actor.organizationId, feature);

    const permission = this.reflector.getAllAndOverride<PermissionKey>(REQUIRED_PERMISSION, targets);
    if (permission && !access.permissions[permission]) throw Errors.forbidden();

    return true;
  }
}
