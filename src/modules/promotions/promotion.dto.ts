import { PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class PromotionDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/\s/g, '').toUpperCase() : value))
  @Matches(/^[A-Z0-9_-]{3,24}$/, { message: 'Código de 3 a 24 letras o números, sin espacios' })
  code: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  description?: string;

  @IsIn(['percent', 'amount'])
  type: 'percent' | 'amount';

  /** Porcentaje (1–100) o monto en céntimos. */
  @IsInt()
  @Min(1)
  value: number;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  serviceIds?: string[];

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(DATE)
  validFrom?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(DATE)
  validTo?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  weekdays?: number[];

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(1440)
  fromMinute?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(1440)
  toMinute?: number | null;

  @IsOptional()
  @IsBoolean()
  newClientsOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  oncePerClient?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  maxUses?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdatePromotionDto extends PartialType(PromotionDto) {}
