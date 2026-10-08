import { Controller, Get, Module, Query } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { IsMongoId, IsOptional, Matches } from 'class-validator';
import { RequirePermission } from '../../core/auth/decorators.js';
import { Appointment, AppointmentSchema } from '../bookings/schemas/appointment.schema.js';
import { Client, ClientSchema } from '../clients/schemas/client.schema.js';
import { BranchException, BranchExceptionSchema } from '../organization/schemas/branch-exception.schema.js';
import { Branch, BranchSchema } from '../organization/schemas/branch.schema.js';
import { Organization, OrganizationSchema } from '../organization/schemas/organization.schema.js';
import { Payment, PaymentSchema } from '../payments/schemas/payment.schemas.js';
import { PlatformModule } from '../platform/platform.module.js';
import { Professional, ProfessionalSchema } from '../professionals/schemas/professional.schema.js';
import { TimeOff, TimeOffSchema } from '../professionals/schemas/time-off.schema.js';
import { ReportsService } from './reports.service.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

class ReportsQuery {
  @Matches(DATE)
  from: string;

  @Matches(DATE)
  to: string;

  @IsOptional()
  @IsMongoId()
  branchId?: string;
}

@Controller('reports')
class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequirePermission('report.view')
  @Get()
  overview(@Query() q: ReportsQuery) {
    return this.reports.overview(q);
  }

  /** Detalle de citas para Excel (reportes completos). */
  @RequirePermission('report.view')
  @Get('export')
  export(@Query() q: ReportsQuery) {
    return this.reports.exportRows(q);
  }
}

/** Reportes: ventas, ocupación, faltas, servicios, profesionales y clientes. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Appointment.name, schema: AppointmentSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: Client.name, schema: ClientSchema },
      { name: Professional.name, schema: ProfessionalSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: BranchException.name, schema: BranchExceptionSchema },
      { name: TimeOff.name, schema: TimeOffSchema },
      { name: Organization.name, schema: OrganizationSchema },
    ]),
    PlatformModule,
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
