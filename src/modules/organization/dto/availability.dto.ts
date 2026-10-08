import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
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
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { DayScheduleDto, TimeRangeDto } from '../../../core/scheduling/weekly-schedule.dto.js';

export class SetOpeningHoursDto {
  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => DayScheduleDto)
  days: DayScheduleDto[];
}

export class CreateBranchExceptionDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Fecha con formato AAAA-MM-DD' })
  date: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @IsIn(['closed', 'custom_hours'])
  type: 'closed' | 'custom_hours';

  @ValidateIf((o: CreateBranchExceptionDto) => o.type === 'custom_hours')
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => TimeRangeDto)
  intervals?: TimeRangeDto[];
}

/** Varias excepciones a la vez (p. ej. cargar los feriados nacionales). */
export class BulkBranchExceptionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => CreateBranchExceptionDto)
  items: CreateBranchExceptionDto[];
}

export class ExceptionsQuery {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;
}

const nullableInt = (min: number, max: number) => [
  IsOptional(),
  ValidateIf((_: unknown, v: unknown) => v !== null),
  IsInt(),
  Min(min),
  Max(max),
];

function Nullable(min: number, max: number): PropertyDecorator {
  return (target, key) => nullableInt(min, max).forEach((d) => d(target, key));
}

export class BookingRulesDto {
  @Nullable(0, 7 * 24 * 60)
  minNoticeMinutes?: number | null;

  @Nullable(1, 730)
  maxAdvanceDays?: number | null;

  @Nullable(0, 24 * 30)
  freeCancellationHours?: number | null;

  @Nullable(0, 20)
  maxReschedules?: number | null;

  @Nullable(0, 240)
  defaultBufferMinutes?: number | null;

  @Nullable(1, 50)
  maxActiveBookingsPerClient?: number | null;

  @IsOptional()
  @IsBoolean()
  allowOverbooking?: boolean;

  @IsOptional()
  @IsIn(['off', 'new_clients', 'all'])
  manualApproval?: 'off' | 'new_clients' | 'all';
}

export class CopyOpeningHoursDto {
  @IsMongoId()
  toBranchId: string;
}

export class UpdateBookingRulesDto extends PartialType(BookingRulesDto) {}
