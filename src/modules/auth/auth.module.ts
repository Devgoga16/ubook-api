import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AccessGuard } from './guards/access.guard.js';
import { AuthGuard } from './guards/auth.guard.js';

@Module({
  imports: [IdentityModule, OrganizationModule, PlatformModule],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, AccessGuard],
  exports: [AuthGuard, AccessGuard],
})
export class AuthModule {}
