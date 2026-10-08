import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { RequireFeature, RequirePermission } from '../../core/auth/decorators.js';
import { ParseObjectIdPipe } from '../../core/common/parse-object-id.pipe.js';
import { AddendumDto, CreateRecordDto, CreateTemplateDto, UpdateRecordDto, UpdateTemplateDto } from './dto/record.dto.js';
import { RecordsService } from './records.service.js';

class TemplatesQuery {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}

/** Fichas clínicas / registros del cliente. Funcionalidad `client_records` del plan. */
@RequireFeature('client_records')
@Controller()
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  @RequirePermission('client_record.read')
  @Get('record-templates')
  listTemplates(@Query() q: TemplatesQuery) {
    return this.records.listTemplates(q.includeInactive);
  }

  @RequirePermission('organization.manage')
  @Get('record-templates/presets')
  presets() {
    return this.records.presets();
  }

  @RequirePermission('organization.manage')
  @Post('record-templates')
  createTemplate(@Body() dto: CreateTemplateDto) {
    return this.records.createTemplate(dto);
  }

  @RequirePermission('organization.manage')
  @Patch('record-templates/:id')
  updateTemplate(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateTemplateDto) {
    return this.records.updateTemplate(id, dto);
  }

  @RequirePermission('client_record.read')
  @Get('clients/:id/records')
  listForClient(@Param('id', ParseObjectIdPipe) id: string) {
    return this.records.listForClient(id);
  }

  @RequirePermission('client_record.write')
  @Post('clients/:id/records')
  create(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: CreateRecordDto) {
    return this.records.create(id, dto);
  }

  @RequirePermission('client_record.write')
  @Patch('records/:id')
  update(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateRecordDto) {
    return this.records.update(id, dto.values);
  }

  @RequirePermission('client_record.write')
  @Post('records/:id/sign')
  sign(@Param('id', ParseObjectIdPipe) id: string) {
    return this.records.sign(id);
  }

  @RequirePermission('client_record.write')
  @Post('records/:id/addenda')
  addAddendum(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: AddendumDto) {
    return this.records.addAddendum(id, dto.text);
  }
}
