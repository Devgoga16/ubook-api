import { Controller, Get, Module, Query } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { IsMongoId } from 'class-validator';
import { RequirePermission } from '../../core/auth/decorators.js';
import { Appointment, AppointmentSchema } from '../bookings/schemas/appointment.schema.js';
import { Client, ClientSchema } from '../clients/schemas/client.schema.js';
import { BranchException, BranchExceptionSchema } from '../organization/schemas/branch-exception.schema.js';
import { Branch, BranchSchema } from '../organization/schemas/branch.schema.js';
import { CashClose, CashCloseSchema, Payment, PaymentSchema } from '../payments/schemas/payment.schemas.js';
import { PlatformModule } from '../platform/platform.module.js';
import { Professional, ProfessionalSchema } from '../professionals/schemas/professional.schema.js';
import { TimeOff, TimeOffSchema } from '../professionals/schemas/time-off.schema.js';
import { DashboardService } from './dashboard.service.js';

class DashboardQuery {
  @IsMongoId()
  branchId: string;
}

@Controller('dashboard')
class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @RequirePermission('booking.read')
  @Get()
  summary(@Query() q: DashboardQuery) {
    return this.dashboard.summary(q.branchId);
  }
}

/** Pantalla de inicio: resumen del día por sede. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Appointment.name, schema: AppointmentSchema },
      { name: Professional.name, schema: ProfessionalSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: BranchException.name, schema: BranchExceptionSchema },
      { name: TimeOff.name, schema: TimeOffSchema },
      { name: Client.name, schema: ClientSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: CashClose.name, schema: CashCloseSchema },
    ]),
    PlatformModule,
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
