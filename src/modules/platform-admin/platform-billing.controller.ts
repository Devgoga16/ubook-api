import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AllowContexts, CurrentActor, PlatformOnly } from '../../core/auth/decorators.js';
import { ParseObjectIdPipe } from '../../core/common/parse-object-id.pipe.js';
import type { Actor } from '../../core/tenancy/tenant-context.js';
import { BillingService } from '../platform/billing.service.js';

class ListPaymentsQuery {
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected'])
  status?: 'pending' | 'approved' | 'rejected';
}

class RejectDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3, { message: 'Escribe el motivo' })
  @MaxLength(300)
  reason: string;
}

/** Revisión de pagos de suscripción por el equipo de Unify Tec. */
@AllowContexts('platform')
@Controller('platform/billing')
export class PlatformBillingController {
  constructor(private readonly billing: BillingService) {}

  @PlatformOnly('super_admin', 'support')
  @Get('payments')
  list(@Query() q: ListPaymentsQuery) {
    return this.billing.listForPlatform(q.status);
  }

  @PlatformOnly('super_admin', 'support')
  @Get('payments/:id/proof')
  proof(@Param('id', ParseObjectIdPipe) id: string) {
    return this.billing.proofUrl(id);
  }

  @PlatformOnly('super_admin')
  @Post('payments/:id/approve')
  approve(@Param('id', ParseObjectIdPipe) id: string, @CurrentActor() actor: Actor) {
    return this.billing.approve(id, actor.userId);
  }

  @PlatformOnly('super_admin')
  @Post('payments/:id/reject')
  reject(@Param('id', ParseObjectIdPipe) id: string, @CurrentActor() actor: Actor, @Body() dto: RejectDto) {
    return this.billing.reject(id, actor.userId, dto.reason);
  }
}
