import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDate,
  IsEmail,
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
import { DayScheduleDto } from '../../../core/scheduling/weekly-schedule.dto.js';
import { TIME_OFF_TYPES, type TimeOffType } from '../schemas/time-off.schema.js';

export class ProfessionalServiceDto {
  @IsMongoId()
  serviceId: string;

  /** Céntimos; `null` = precio del servicio. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  price?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(5)
  @Max(720)
  durationMinutes?: number | null;
}

export class CreateProfessionalDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  displayName: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string;

  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  color?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Matches(/^\+?[0-9 ()-]{6,20}$/)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsMongoId()
  membershipId?: string | null;

  /** Al menos una sede. */
  @IsArray()
  @ArrayUnique()
  @IsMongoId({ each: true })
  branchIds: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ProfessionalServiceDto)
  services?: ProfessionalServiceDto[];

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(100)
  commissionPercent?: number | null;
}

export class UpdateProfessionalDto extends PartialType(CreateProfessionalDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Reemplaza el horario semanal del profesional en una sede. */
export class SetScheduleDto {
  @IsMongoId()
  branchId: string;

  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => DayScheduleDto)
  days: DayScheduleDto[];
}

export class CreateTimeOffDto {
  @IsIn(TIME_OFF_TYPES)
  type: TimeOffType;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string;

  @Type(() => Date)
  @IsDate()
  startsAt: Date;

  @Type(() => Date)
  @IsDate()
  endsAt: Date;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class DecideTimeOffDto {
  @IsIn(['approved', 'rejected'])
  status: 'approved' | 'rejected';
}

export class TimeOffQuery {
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}
