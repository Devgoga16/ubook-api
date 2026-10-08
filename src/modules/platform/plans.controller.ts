import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { AllowContexts, PlatformOnly, Public } from '../../core/auth/decorators.js';
import { CreatePlanDto, UpdatePlanDto } from './dto/plan.dto.js';
import { FEATURES } from './features.catalog.js';
import { PlansService } from './plans.service.js';

@Controller()
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  /** Planes para la página de precios (landing y registro). */
  @Public()
  @Get('plans')
  listPublic() {
    return this.plans.listPublic();
  }

  /** Catálogo de funcionalidades, para armar la tabla comparativa. */
  @Public()
  @Get('plans/features')
  features() {
    return Object.entries(FEATURES).map(([key, def]) => ({ key, ...def }));
  }

  @AllowContexts('platform')
  @PlatformOnly('super_admin', 'support')
  @Get('platform/plans')
  listAll() {
    return this.plans.listAll();
  }

  @AllowContexts('platform')
  @PlatformOnly()
  @Post('platform/plans')
  create(@Body() dto: CreatePlanDto) {
    return this.plans.create(dto);
  }

  @AllowContexts('platform')
  @PlatformOnly()
  @Patch('platform/plans/:code')
  update(@Param('code') code: string, @Body() dto: UpdatePlanDto) {
    return this.plans.update(code, dto);
  }
}
