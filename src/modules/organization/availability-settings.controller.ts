import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { RequirePermission } from '../../core/auth/decorators.js';
import { ParseObjectIdPipe } from '../../core/common/parse-object-id.pipe.js';
import { AvailabilitySettingsService } from './availability-settings.service.js';
import {
  BulkBranchExceptionsDto,
  CopyOpeningHoursDto,
  CreateBranchExceptionDto,
  ExceptionsQuery,
  SetOpeningHoursDto,
  UpdateBookingRulesDto,
} from './dto/availability.dto.js';

/** Ajustes / Disponibilidad. */
@Controller()
export class AvailabilitySettingsController {
  constructor(private readonly settings: AvailabilitySettingsService) {}

  @RequirePermission('branch.manage')
  @Put('branches/:id/hours')
  setHours(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: SetOpeningHoursDto) {
    return this.settings.setOpeningHours(id, dto.days);
  }

  @RequirePermission('branch.manage')
  @Post('branches/:id/hours/copy')
  copyHours(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: CopyOpeningHoursDto) {
    return this.settings.copyOpeningHours(id, dto.toBranchId);
  }

  @RequirePermission('schedule.read')
  @Get('branches/:id/exceptions')
  listExceptions(@Param('id', ParseObjectIdPipe) id: string, @Query() query: ExceptionsQuery) {
    return this.settings.listExceptions(id, query.from, query.to);
  }

  @RequirePermission('branch.manage')
  @Post('branches/:id/exceptions')
  createException(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: CreateBranchExceptionDto) {
    return this.settings.createException(id, dto);
  }

  @RequirePermission('branch.manage')
  @Post('branches/:id/exceptions/bulk')
  @HttpCode(200)
  bulkExceptions(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: BulkBranchExceptionsDto) {
    return this.settings.createExceptions(id, dto.items);
  }

  @RequirePermission('branch.manage')
  @Delete('branch-exceptions/:id')
  @HttpCode(204)
  removeException(@Param('id', ParseObjectIdPipe) id: string) {
    return this.settings.removeException(id);
  }

  /** Cualquier miembro del staff puede leer las reglas (las usa la agenda). */
  @Get('booking-rules')
  getRules() {
    return this.settings.getRules();
  }

  @RequirePermission('organization.manage')
  @Patch('booking-rules')
  updateRules(@Body() dto: UpdateBookingRulesDto) {
    return this.settings.updateRules(dto);
  }
}
