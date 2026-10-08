import { Body, Controller, Get, Module, Param, Patch, Post } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RequirePermission } from '../../core/auth/decorators.js';
import { ParseObjectIdPipe } from '../../core/common/parse-object-id.pipe.js';
import { Appointment, AppointmentSchema } from '../bookings/schemas/appointment.schema.js';
import { PromotionDto, UpdatePromotionDto } from './promotion.dto.js';
import { Promotion, PromotionSchema } from './promotion.schema.js';
import { PromotionsService } from './promotions.service.js';

@Controller('promotions')
class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @RequirePermission('organization.manage')
  @Get()
  list() {
    return this.promotions.list();
  }

  @RequirePermission('organization.manage')
  @Post()
  create(@Body() dto: PromotionDto) {
    return this.promotions.create(dto);
  }

  @RequirePermission('organization.manage')
  @Patch(':id')
  update(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdatePromotionDto) {
    return this.promotions.update(id, dto);
  }
}

/** Cupones de descuento. La validación al reservar la usa el módulo de reservas. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Promotion.name, schema: PromotionSchema },
      { name: Appointment.name, schema: AppointmentSchema },
    ]),
  ],
  controllers: [PromotionsController],
  providers: [PromotionsService],
  exports: [PromotionsService],
})
export class PromotionsModule {}
