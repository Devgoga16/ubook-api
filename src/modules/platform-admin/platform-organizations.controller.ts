import { Body, Controller, Delete, Get, Param, Patch, Query } from '@nestjs/common';
import type { Actor } from '../../core/tenancy/tenant-context.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { AllowContexts, CurrentActor, PlatformOnly } from '../../core/auth/decorators.js';
import { ParseObjectIdPipe } from '../../core/common/parse-object-id.pipe.js';
import { OrganizationsService } from '../organization/organizations.service.js';
import { effectiveStatus } from '../platform/entitlements.service.js';
import { SubscriptionsService } from '../platform/subscriptions.service.js';
import {
  DeleteOrganizationDto,
  ListOrganizationsQuery,
  PlatformUpdateOrganizationDto,
  PlatformUpdateOwnerDto,
  UpdateOrganizationStatusDto,
  UpdateSubscriptionDto,
} from './dto.js';
import { PlatformOrganizationsService } from './platform-organizations.service.js';

/** Gestión de negocios por el equipo de Unify Tec. */
@AllowContexts('platform')
@Controller('platform/organizations')
export class PlatformOrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly audit: AuditService,
    private readonly platformOrgs: PlatformOrganizationsService,
  ) {}

  @PlatformOnly('super_admin', 'support')
  @Get()
  async list(@Query() query: ListOrganizationsQuery) {
    const result = await this.organizations.listForPlatform(query.page, query.pageSize, query.search);
    const subs = await this.subscriptions.findByOrganizations(result.items.map((o) => o.id as string));
    const subByOrg = new Map(subs.map((s) => [s.organizationId.toString(), s]));
    return {
      ...result,
      items: result.items.map((org) => {
        const sub = subByOrg.get(org.id as string);
        return {
          ...org.toJSON(),
          subscription: sub ? { ...sub.toJSON(), effectiveStatus: effectiveStatus(sub) } : null,
        };
      }),
    };
  }

  /** Ficha completa de la cuenta: negocio, dueño, suscripción, pagos y uso. */
  @PlatformOnly('super_admin', 'support')
  @Get(':id')
  detail(@Param('id', ParseObjectIdPipe) id: string) {
    return this.platformOrgs.detail(id);
  }

  @PlatformOnly()
  @Patch(':id')
  update(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: PlatformUpdateOrganizationDto, @CurrentActor() actor: Actor) {
    return this.platformOrgs.update(id, dto, actor.userId);
  }

  @PlatformOnly()
  @Patch(':id/owners/:userId')
  updateOwner(
    @Param('id', ParseObjectIdPipe) id: string,
    @Param('userId', ParseObjectIdPipe) userId: string,
    @Body() dto: PlatformUpdateOwnerDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.platformOrgs.updateOwner(id, userId, dto, actor.userId);
  }

  @PlatformOnly()
  @Patch(':id/subscription')
  async updateSubscription(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateSubscriptionDto) {
    const subscription = await this.subscriptions.update(id, dto);
    await this.audit.log({
      action: 'platform.subscription_updated',
      entityType: 'Subscription',
      entityId: subscription.id as string,
      organizationId: id,
      metadata: { ...dto },
    });
    return subscription;
  }

  /** Borrado definitivo del negocio y todo lo suyo. Solo super_admin y con confirmación. */
  @PlatformOnly()
  @Delete(':id')
  remove(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: DeleteOrganizationDto, @CurrentActor() actor: Actor) {
    return this.platformOrgs.remove(id, dto.confirm, actor.userId);
  }

  @PlatformOnly()
  @Patch(':id/status')
  updateStatus(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateOrganizationStatusDto) {
    return this.organizations.setStatus(id, dto.status);
  }
}
