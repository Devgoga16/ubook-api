import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ServiceCategory, ServiceCategorySchema } from '../catalog/schemas/service-category.schema.js';
import { Service, ServiceSchema } from '../catalog/schemas/service.schema.js';
import { ClientsController } from '../clients/clients.controller.js';
import { ClientsService } from '../clients/clients.service.js';
import { Client, ClientSchema } from '../clients/schemas/client.schema.js';
import { BranchException, BranchExceptionSchema } from '../organization/schemas/branch-exception.schema.js';
import { Branch, BranchSchema } from '../organization/schemas/branch.schema.js';
import { Organization, OrganizationSchema } from '../organization/schemas/organization.schema.js';
import { Professional, ProfessionalSchema } from '../professionals/schemas/professional.schema.js';
import { PlatformModule } from '../platform/platform.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PromotionsModule } from '../promotions/promotions.module.js';
import { Resource, ResourceSchema } from '../resources/resource.schema.js';
import { TimeOff, TimeOffSchema } from '../professionals/schemas/time-off.schema.js';
import { AppointmentsService } from './appointments.service.js';
import { AvailabilityService } from './availability.service.js';
import { BookingLinksService } from './booking-links.service.js';
import { BookingMailerService } from './booking-mailer.service.js';
import { BookingRemindersService } from './booking-reminders.service.js';
import { BookingsController } from './bookings.controller.js';
import { PublicBookingController } from './public-booking.controller.js';
import { PublicBookingService } from './public-booking.service.js';
import { Appointment, AppointmentSchema } from './schemas/appointment.schema.js';
import { Counter, CounterSchema } from './schemas/counter.schema.js';
import { WaitlistEntry, WaitlistEntrySchema } from './schemas/waitlist.schema.js';
import { AutomationSettings, AutomationSettingsSchema, NotificationLog, NotificationLogSchema } from './automations/automation.schemas.js';
import { AutomationsController } from './automations/automations.controller.js';
import { AutomationsService } from './automations/automations.service.js';
import { User, UserSchema } from '../identity/schemas/user.schema.js';
import { WaitlistController } from './waitlist.controller.js';
import { WaitlistService } from './waitlist.service.js';

/** Agenda: disponibilidad, citas y clientes (los clientes tendrán su módulo cuando crezca la ficha). */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Appointment.name, schema: AppointmentSchema },
      { name: Counter.name, schema: CounterSchema },
      { name: WaitlistEntry.name, schema: WaitlistEntrySchema },
      { name: Resource.name, schema: ResourceSchema },
      { name: AutomationSettings.name, schema: AutomationSettingsSchema },
      { name: NotificationLog.name, schema: NotificationLogSchema },
      { name: User.name, schema: UserSchema },
      { name: Client.name, schema: ClientSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: BranchException.name, schema: BranchExceptionSchema },
      { name: Service.name, schema: ServiceSchema },
      { name: ServiceCategory.name, schema: ServiceCategorySchema },
      { name: Professional.name, schema: ProfessionalSchema },
      { name: TimeOff.name, schema: TimeOffSchema },
      { name: Organization.name, schema: OrganizationSchema },
    ]),
    PlatformModule,
    PromotionsModule,
    NotificationsModule,
  ],
  controllers: [BookingsController, ClientsController, PublicBookingController, WaitlistController, AutomationsController],
  providers: [
    AvailabilityService,
    AppointmentsService,
    ClientsService,
    BookingLinksService,
    BookingMailerService,
    BookingRemindersService,
    PublicBookingService,
    WaitlistService,
    AutomationsService,
  ],
  exports: [AppointmentsService],
})
export class BookingsModule {}
