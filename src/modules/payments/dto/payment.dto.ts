import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PAYMENT_METHODS, type PaymentMethod } from '../schemas/payment.schemas.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class PaymentPartDto {
  @IsIn(PAYMENT_METHODS)
  method: PaymentMethod;

  /** Céntimos. */
  @IsInt()
  @Min(1)
  amount: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  reference?: string;
}

export class CreatePaymentDto {
  /** Cómo pagó: uno o varios métodos (p. ej. parte efectivo, parte Yape). Suma = servicio + propina. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => PaymentPartDto)
  methods: PaymentPartDto[];

  @IsOptional()
  @IsInt()
  @Min(0)
  discount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  tip?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  note?: string;

  /** Marcar la cita como completada al cobrar. */
  @IsOptional()
  @IsBoolean()
  complete?: boolean;
}

export class VoidPaymentDto {
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: 'Escribe el motivo' })
  @MaxLength(300)
  reason: string;
}

export class ListPaymentsQuery {
  @IsOptional()
  @IsMongoId()
  branchId?: string;

  @Matches(DATE)
  from: string;

  @Matches(DATE)
  to: string;

  @IsOptional()
  @IsMongoId()
  professionalId?: string;

  @IsOptional()
  @IsIn(['paid', 'voided'])
  status?: 'paid' | 'voided';
}

export class CommissionsQuery {
  @IsOptional()
  @IsMongoId()
  branchId?: string;

  @IsOptional()
  @IsMongoId()
  professionalId?: string;

  @Matches(DATE)
  from: string;

  @Matches(DATE)
  to: string;
}

export class CashDayQuery {
  @IsMongoId()
  branchId: string;

  @Matches(DATE)
  date: string;
}

export class CashMovementDto {
  @IsMongoId()
  branchId: string;

  @IsIn(['in', 'out'])
  type: 'in' | 'out';

  @IsInt()
  @Min(1)
  amount: number;

  @Transform(trim)
  @IsString()
  @MinLength(2, { message: 'Escribe el concepto' })
  @MaxLength(120)
  concept: string;
}

export class CloseCashDto {
  @IsMongoId()
  branchId: string;

  @Matches(DATE)
  date: string;

  @IsInt()
  @Min(0)
  openingCash: number;

  @IsInt()
  @Min(0)
  countedCash: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class ReopenCashDto {
  @IsMongoId()
  branchId: string;

  @Matches(DATE)
  date: string;
}
