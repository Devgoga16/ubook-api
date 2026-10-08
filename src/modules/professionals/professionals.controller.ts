import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { RequirePermission } from '../../core/auth/decorators.js';
import { ParseObjectIdPipe } from '../../core/common/parse-object-id.pipe.js';
import {
  CreateProfessionalDto,
  CreateTimeOffDto,
  DecideTimeOffDto,
  SetScheduleDto,
  TimeOffQuery,
  UpdateProfessionalDto,
} from './dto/professional.dto.js';
import { ProfessionalsService } from './professionals.service.js';

/**
 * Los endpoints sin @RequirePermission comprueban el alcance (propio,
 * sucursal o negocio) dentro del servicio, porque depende del profesional.
 */
@Controller()
export class ProfessionalsController {
  constructor(private readonly professionals: ProfessionalsService) {}

  @Get('professionals')
  list() {
    return this.professionals.list();
  }

  @Get('professionals/:id')
  get(@Param('id', ParseObjectIdPipe) id: string) {
    return this.professionals.get(id);
  }

  @RequirePermission('professional.manage')
  @Post('professionals')
  create(@Body() dto: CreateProfessionalDto) {
    return this.professionals.create(dto);
  }

  @RequirePermission('professional.manage')
  @Patch('professionals/:id')
  update(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateProfessionalDto) {
    return this.professionals.update(id, dto);
  }

  @RequirePermission('schedule.manage')
  @Put('professionals/:id/schedule')
  setSchedule(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: SetScheduleDto) {
    return this.professionals.setSchedule(id, dto);
  }

  @Get('professionals/:id/time-off')
  listTimeOff(@Param('id', ParseObjectIdPipe) id: string, @Query() query: TimeOffQuery) {
    return this.professionals.listTimeOff(id, query.from, query.to);
  }

  @RequirePermission('schedule.manage')
  @Post('professionals/:id/time-off')
  createTimeOff(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: CreateTimeOffDto) {
    return this.professionals.createTimeOff(id, dto);
  }

  @RequirePermission('schedule.manage')
  @Patch('time-off/:id')
  decideTimeOff(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: DecideTimeOffDto) {
    return this.professionals.decideTimeOff(id, dto.status);
  }

  @RequirePermission('schedule.manage')
  @Delete('time-off/:id')
  @HttpCode(204)
  removeTimeOff(@Param('id', ParseObjectIdPipe) id: string) {
    return this.professionals.removeTimeOff(id);
  }
}
