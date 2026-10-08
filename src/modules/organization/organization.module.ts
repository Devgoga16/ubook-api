import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../identity/schemas/user.schema.js';
import { Professional, ProfessionalSchema } from '../professionals/schemas/professional.schema.js';
import { PlatformModule } from '../platform/platform.module.js';
import { AccessControlService } from './access-control.service.js';
import { AvailabilitySettingsController } from './availability-settings.controller.js';
import { AvailabilitySettingsService } from './availability-settings.service.js';
import { BranchException, BranchExceptionSchema } from './schemas/branch-exception.schema.js';
import { BranchesService } from './branches.service.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';
import { MembersService } from './members.service.js';
import { Invitation, InvitationSchema } from './schemas/invitation.schema.js';
import { OrganizationController } from './organization.controller.js';
import { OrganizationsService } from './organizations.service.js';
import { RolesService } from './roles.service.js';
import { Branch, BranchSchema } from './schemas/branch.schema.js';
import { Membership, MembershipSchema } from './schemas/membership.schema.js';
import { Organization, OrganizationSchema } from './schemas/organization.schema.js';
import { Role, RoleSchema } from './schemas/role.schema.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Organization.name, schema: OrganizationSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: BranchException.name, schema: BranchExceptionSchema },
      { name: Role.name, schema: RoleSchema },
      { name: Membership.name, schema: MembershipSchema },
      { name: User.name, schema: UserSchema },
      { name: Invitation.name, schema: InvitationSchema },
      { name: Professional.name, schema: ProfessionalSchema },
    ]),
    PlatformModule,
  ],
  controllers: [OrganizationController, AvailabilitySettingsController, InvitationsController],
  providers: [
    OrganizationsService,
    AccessControlService,
    RolesService,
    BranchesService,
    MembersService,
    AvailabilitySettingsService,
    InvitationsService,
  ],
  exports: [OrganizationsService, AccessControlService, AvailabilitySettingsService, InvitationsService],
})
export class OrganizationModule {}
