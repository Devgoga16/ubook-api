import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClsModule } from 'nestjs-cls';
import { validateEnv } from './config/env.js';
import { AuditModule } from './core/audit/audit.module.js';
import { DatabaseModule } from './core/database/database.module.js';
import { MailModule } from './core/mail/mail.module.js';
import { StorageModule } from './core/storage/storage.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BookingsModule } from './modules/bookings/bookings.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { ResourcesModule } from './modules/resources/resources.module.js';
import { ProfessionalsModule } from './modules/professionals/professionals.module.js';
import { RecordsModule } from './modules/records/records.module.js';
import { AccessGuard } from './modules/auth/guards/access.guard.js';
import { AuthGuard } from './modules/auth/guards/auth.guard.js';
import { HealthController } from './modules/health/health.controller.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { OrganizationModule } from './modules/organization/organization.module.js';
import { PlatformAdminModule } from './modules/platform-admin/platform-admin.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    DatabaseModule,
    AuditModule,
    MailModule,
    StorageModule,
    IdentityModule,
    PlatformModule,
    OrganizationModule,
    AuthModule,
    PlatformAdminModule,
    CatalogModule,
    ProfessionalsModule,
    NotificationsModule,
    BookingsModule,
    RecordsModule,
    PaymentsModule,
    DashboardModule,
    ReportsModule,
    ResourcesModule,
  ],
  controllers: [HealthController],
  providers: [
    // Orden: límite de peticiones → autenticación → plan y permisos.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useExisting: AuthGuard },
    { provide: APP_GUARD, useExisting: AccessGuard },
  ],
})
export class AppModule {}
