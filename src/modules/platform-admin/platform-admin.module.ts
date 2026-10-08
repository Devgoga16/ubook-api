import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../identity/schemas/user.schema.js';
import { Organization, OrganizationSchema } from '../organization/schemas/organization.schema.js';
import { PlatformOrganizationsService } from './platform-organizations.service.js';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PlatformBootstrapService } from './platform-bootstrap.service.js';
import { PlatformBillingController } from './platform-billing.controller.js';
import { PlatformOrganizationsController } from './platform-organizations.controller.js';

/** Panel de super admin: negocios, suscripciones y arranque de la plataforma. */
@Module({
  imports: [
    IdentityModule,
    OrganizationModule,
    PlatformModule,
    MongooseModule.forFeature([
      { name: Organization.name, schema: OrganizationSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [PlatformOrganizationsController, PlatformBillingController],
  providers: [PlatformBootstrapService, PlatformOrganizationsService],
})
export class PlatformAdminModule {}
