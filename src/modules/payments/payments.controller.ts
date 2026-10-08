import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { RequireFeature, RequirePermission } from '../../core/auth/decorators.js';
import { ParseObjectIdPipe } from '../../core/common/parse-object-id.pipe.js';
import {
  CashDayQuery,
  CashMovementDto,
  CloseCashDto,
  CommissionsQuery,
  CreatePaymentDto,
  ListPaymentsQuery,
  ReopenCashDto,
  VoidPaymentDto,
} from './dto/payment.dto.js';
import { PaymentsService } from './payments.service.js';

/** Cobros manuales, caja del día y comisiones. Funcionalidad `manual_payments` del plan. */
@RequireFeature('manual_payments')
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @RequirePermission('payment.read')
  @Get('appointments/:id/payments')
  forAppointment(@Param('id', ParseObjectIdPipe) id: string) {
    return this.payments.forAppointment(id);
  }

  @RequirePermission('payment.create')
  @Post('appointments/:id/payments')
  create(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: CreatePaymentDto) {
    return this.payments.create(id, dto);
  }

  @RequirePermission('booking.read')
  @Get('appointments/:id/deposit/proof')
  depositProof(@Param('id', ParseObjectIdPipe) id: string) {
    return this.payments.depositProof(id);
  }

  @RequirePermission('payment.create')
  @Post('appointments/:id/deposit/approve')
  approveDeposit(@Param('id', ParseObjectIdPipe) id: string) {
    return this.payments.approveDeposit(id);
  }

  @RequirePermission('payment.create')
  @Post('appointments/:id/deposit/reject')
  rejectDeposit(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: VoidPaymentDto) {
    return this.payments.rejectDeposit(id, dto.reason);
  }

  @RequirePermission('payment.void')
  @Post('payments/:id/void')
  void(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: VoidPaymentDto) {
    return this.payments.void(id, dto.reason);
  }

  @RequirePermission('payment.read')
  @Get('payments')
  list(@Query() q: ListPaymentsQuery) {
    return this.payments.list(q);
  }

  @RequirePermission('payment.read')
  @Get('payments/commissions')
  commissions(@Query() q: CommissionsQuery) {
    return this.payments.commissions(q);
  }

  @RequirePermission('payment.read')
  @Get('cash/day')
  cashDay(@Query() q: CashDayQuery) {
    return this.payments.cashDay(q.branchId, q.date);
  }

  @RequirePermission('payment.create')
  @Post('cash/movements')
  addMovement(@Body() dto: CashMovementDto) {
    return this.payments.addMovement(dto);
  }

  @RequirePermission('payment.create')
  @Post('cash/close')
  close(@Body() dto: CloseCashDto) {
    return this.payments.close(dto);
  }

  /** Reabrir un día cerrado: solo quien puede anular pagos. */
  @RequirePermission('payment.void')
  @Post('cash/reopen')
  reopen(@Body() dto: ReopenCashDto) {
    return this.payments.reopen(dto.branchId, dto.date);
  }
}
