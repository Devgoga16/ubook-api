import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Client, ClientSchema } from '../clients/schemas/client.schema.js';
import { IdentityModule } from '../identity/identity.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { User, UserSchema } from '../identity/schemas/user.schema.js';
import { Organization, OrganizationSchema } from '../organization/schemas/organization.schema.js';
import { PlatformModule } from '../platform/platform.module.js';
import { PlatformSupportController, PlatformTeamController } from './platform-support.controller.js';
import { PlatformTeamService } from './platform-team.service.js';
import { SupportTicketsService } from './support-tickets.service.js';
import { ClientInquiriesController, SupportController } from './support.controller.js';
import { SupportCounter, SupportCounterSchema, SupportMessage, SupportMessageSchema, SupportTicket, SupportTicketSchema } from './support.schemas.js';

/** Tickets de soporte (negocio ↔ Unify Tec) y equipo de plataforma que los atiende. */
@Module({
  imports: [
    IdentityModule,
    PlatformModule,
    NotificationsModule,
    MongooseModule.forFeature([
      { name: Client.name, schema: ClientSchema },
      { name: SupportTicket.name, schema: SupportTicketSchema },
      { name: SupportMessage.name, schema: SupportMessageSchema },
      { name: SupportCounter.name, schema: SupportCounterSchema },
      { name: Organization.name, schema: OrganizationSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [SupportController, ClientInquiriesController, PlatformSupportController, PlatformTeamController],
  providers: [SupportTicketsService, PlatformTeamService],
  exports: [SupportTicketsService],
})
export class SupportModule {}
