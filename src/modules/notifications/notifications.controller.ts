import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AllowWhenReadOnly, RequirePermission } from '../../core/auth/decorators.js';
import { NotificationsService } from './notifications.service.js';

/** Avisos del equipo (campana del encabezado). */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @RequirePermission('booking.read')
  @AllowWhenReadOnly()
  @Get()
  list() {
    return this.notifications.list();
  }

  @RequirePermission('booking.read')
  @AllowWhenReadOnly()
  @Post('read-all')
  @HttpCode(200)
  markAllRead() {
    return this.notifications.markAllRead();
  }
}
