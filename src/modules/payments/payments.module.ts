import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BookingsModule } from '../bookings/bookings.module.js';
import { Appointment, AppointmentSchema } from '../bookings/schemas/appointment.schema.js';
import { Counter, CounterSchema } from '../bookings/schemas/counter.schema.js';
import { Client, ClientSchema } from '../clients/schemas/client.schema.js';
import { Branch, BranchSchema } from '../organization/schemas/branch.schema.js';
import { Professional, ProfessionalSchema } from '../professionals/schemas/professional.schema.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { CashClose, CashCloseSchema, CashMovement, CashMovementSchema, Payment, PaymentSchema } from './schemas/payment.schemas.js';

/** Cobros manuales (efectivo, Yape, Plin, POS…), caja del día y comisiones. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Payment.name, schema: PaymentSchema },
      { name: CashMovement.name, schema: CashMovementSchema },
      { name: CashClose.name, schema: CashCloseSchema },
      { name: Appointment.name, schema: AppointmentSchema },
      { name: Counter.name, schema: CounterSchema },
      { name: Professional.name, schema: ProfessionalSchema },
      { name: Client.name, schema: ClientSchema },
      { name: Branch.name, schema: BranchSchema },
    ]),
    BookingsModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
