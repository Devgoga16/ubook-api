import { Body, Controller, Get, HttpCode, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_IMAGE_BYTES } from '../../core/storage/storage.service.js';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../core/auth/decorators.js';
import {
  CancelBookingDto,
  ManageDaysQuery,
  ManageSlotsQuery,
  PublicBookingDto,
  PublicDaysQuery,
  PublicSlotsQuery,
  PromoQuery,
  RescheduleBookingDto,
} from './dto/public-booking.dto.js';
import { PublicWaitlistDto } from './dto/waitlist.dto.js';
import { PublicBookingService } from './public-booking.service.js';

const STRICT = { default: { limit: 10, ttl: 60_000 } };
const BROWSE = { default: { limit: 120, ttl: 60_000 } };

/** Reservas online sin cuenta: página del negocio y gestión de la cita por enlace. */
@Public()
@Controller('public')
export class PublicBookingController {
  constructor(private readonly booking: PublicBookingService) {}

  @Throttle(BROWSE)
  @Get('businesses/:slug')
  info(@Param('slug') slug: string) {
    return this.booking.info(slug);
  }

  @Throttle(BROWSE)
  @Get('businesses/:slug/slots')
  slots(@Param('slug') slug: string, @Query() q: PublicSlotsQuery) {
    return this.booking.slots(slug, q);
  }

  @Throttle(BROWSE)
  @Get('businesses/:slug/days')
  days(@Param('slug') slug: string, @Query() q: PublicDaysQuery) {
    return this.booking.days(slug, q);
  }

  /** Foto del comprobante del adelanto (campo "file"). */
  @Throttle(STRICT)
  @Post('businesses/:slug/uploads')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  upload(@Param('slug') slug: string, @UploadedFile() file?: { buffer: Buffer }) {
    return this.booking.uploadDeposit(slug, file?.buffer ?? Buffer.alloc(0));
  }

  @Throttle(STRICT)
  @Post('businesses/:slug/bookings')
  book(@Param('slug') slug: string, @Body() dto: PublicBookingDto) {
    return this.booking.book(slug, dto);
  }

  @Throttle(STRICT)
  @Get('businesses/:slug/promotions/:code')
  promo(@Param('slug') slug: string, @Param('code') code: string, @Query() q: PromoQuery) {
    return this.booking.promo(slug, code, q.serviceId);
  }

  @Throttle(STRICT)
  @Post('businesses/:slug/waitlist')
  joinWaitlist(@Param('slug') slug: string, @Body() dto: PublicWaitlistDto) {
    return this.booking.joinWaitlist(slug, dto);
  }

  @Throttle(BROWSE)
  @Get('bookings/:token')
  manage(@Param('token') token: string) {
    return this.booking.manage(token);
  }

  @Throttle(BROWSE)
  @Get('bookings/:token/slots')
  manageSlots(@Param('token') token: string, @Query() q: ManageSlotsQuery) {
    return this.booking.manageSlots(token, q.date);
  }

  @Throttle(BROWSE)
  @Get('bookings/:token/days')
  manageDays(@Param('token') token: string, @Query() q: ManageDaysQuery) {
    return this.booking.manageDays(token, q.from, q.to);
  }

  @Throttle(STRICT)
  @Post('bookings/:token/cancel')
  @HttpCode(200)
  cancel(@Param('token') token: string, @Body() dto: CancelBookingDto) {
    return this.booking.cancel(token, dto.reason);
  }

  @Throttle(STRICT)
  @Post('bookings/:token/reschedule')
  @HttpCode(200)
  reschedule(@Param('token') token: string, @Body() dto: RescheduleBookingDto) {
    return this.booking.reschedule(token, dto.startsAt);
  }
}
