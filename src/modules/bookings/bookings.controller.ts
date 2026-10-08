import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../../core/auth/decorators.js';
import { ParseObjectIdPipe } from '../../core/common/parse-object-id.pipe.js';
import { AppointmentsService } from './appointments.service.js';
import { AvailabilityService } from './availability.service.js';
import {
  AvailabilityDaysQuery,
  AvailabilityQuery,
  ChangeStatusDto,
  CreateAppointmentDto,
  ListAppointmentsQuery,
  RescheduleDto,
  UpdateAppointmentDto,
} from './dto/booking.dto.js';

@Controller()
export class BookingsController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly appointments: AppointmentsService,
  ) {}

  /** Horarios de un día, por profesional. */
  @RequirePermission('booking.create')
  @Get('availability')
  async slots(@Query() q: AvailabilityQuery) {
    const result = await this.availability.compute({ ...q, from: q.date, to: q.date, applyRules: false });
    return {
      date: q.date,
      timezone: result.timezone,
      professionals: result.professionals.map(({ days, ...p }) => ({ ...p, slots: days[0]?.slots ?? [] })),
    };
  }

  /** Para el calendario: cuántos horarios libres hay cada día (0 = lleno o cerrado). */
  @RequirePermission('booking.create')
  @Get('availability/days')
  async days(@Query() q: AvailabilityDaysQuery) {
    const result = await this.availability.compute({ ...q, applyRules: false });
    const totals = new Map<string, { free: number; total: number }>();
    for (const p of result.professionals) {
      for (const d of p.days) {
        const t = totals.get(d.date) ?? { free: 0, total: 0 };
        t.total += d.slots.length;
        t.free += d.slots.filter((s) => s.available).length;
        totals.set(d.date, t);
      }
    }
    return { days: [...totals].map(([date, t]) => ({ date, ...t })) };
  }

  @RequirePermission('booking.read')
  @Get('appointments')
  list(@Query() q: ListAppointmentsQuery) {
    return this.appointments.list(q);
  }

  @RequirePermission('booking.read')
  @Get('appointments/:id')
  get(@Param('id', ParseObjectIdPipe) id: string) {
    return this.appointments.get(id);
  }

  @RequirePermission('booking.create')
  @Post('appointments')
  create(@Body() dto: CreateAppointmentDto) {
    return this.appointments.create(dto);
  }

  /** booking.update; para cancelar se exige además booking.cancel (en el servicio). */
  @RequirePermission('booking.update')
  @Post('appointments/:id/status')
  changeStatus(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: ChangeStatusDto) {
    return this.appointments.changeStatus(id, dto.status, dto.note, dto.by);
  }

  @RequirePermission('booking.update')
  @Post('appointments/:id/reschedule')
  reschedule(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: RescheduleDto) {
    return this.appointments.reschedule(id, dto);
  }

  @RequirePermission('booking.update')
  @Patch('appointments/:id')
  update(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateAppointmentDto) {
    return this.appointments.update(id, dto);
  }

  /** Citas próximas, historial y resumen de un cliente. */
  @RequirePermission('booking.read')
  @Get('clients/:id/appointments')
  forClient(@Param('id', ParseObjectIdPipe) id: string) {
    return this.appointments.forClient(id);
  }
}
