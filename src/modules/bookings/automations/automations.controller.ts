import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { CurrentActor, RequirePermission } from '../../../core/auth/decorators.js';
import { Errors } from '../../../core/common/errors.js';
import type { Actor } from '../../../core/tenancy/tenant-context.js';
import { CHANNELS, FLOWS, type Channel, type FlowKey } from './automation.schemas.js';
import { AutomationsService } from './automations.service.js';

class UpdateFlowDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @IsIn(CHANNELS, { each: true })
  channels?: Channel[];

  /** Horas (recordatorio 1–72, reseña 1–48) o días (reactivar 14–365). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  offset?: number;

  @IsOptional()
  @IsString()
  @MaxLength(700)
  message?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(24)
  promoCode?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'Pega el enlace completo (https://…)' })
  link?: string | null;
}

class LogQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

const OFFSET_LIMITS: Partial<Record<FlowKey, [number, number]>> = { reminder: [1, 72], review: [1, 48], reactivation: [14, 365] };

function assertFlow(flow: string): FlowKey {
  if (!(FLOWS as readonly string[]).includes(flow)) throw Errors.notFound('Automatización');
  return flow as FlowKey;
}

/** Negocio / Automatizaciones. */
@Controller('automations')
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @RequirePermission('organization.manage')
  @Get()
  overview() {
    return this.automations.overview();
  }

  @RequirePermission('organization.manage')
  @Get('log')
  log(@Query() q: LogQuery) {
    return this.automations.log(q.limit);
  }

  @RequirePermission('organization.manage')
  @Patch(':flow')
  update(@Param('flow') flow: string, @Body() dto: UpdateFlowDto) {
    const key = assertFlow(flow);
    const limits = OFFSET_LIMITS[key];
    if (dto.offset != null && limits && (dto.offset < limits[0] || dto.offset > limits[1])) {
      throw Errors.badRequest('INVALID_OFFSET', `Elige un valor entre ${limits[0]} y ${limits[1]}`);
    }
    return this.automations.update(key, { ...dto, ...(dto.link === '' && { link: null }) });
  }

  @RequirePermission('organization.manage')
  @Post(':flow/test')
  test(@Param('flow') flow: string, @CurrentActor() actor: Actor) {
    return this.automations.test(assertFlow(flow), actor.userId);
  }
}
