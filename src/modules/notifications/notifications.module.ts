import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Membership, MembershipSchema } from '../organization/schemas/membership.schema.js';
import { Professional, ProfessionalSchema } from '../professionals/schemas/professional.schema.js';
import { Notification, NotificationSchema } from './notification.schema.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Notification.name, schema: NotificationSchema },
      { name: Membership.name, schema: MembershipSchema },
      { name: Professional.name, schema: ProfessionalSchema },
    ]),
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
