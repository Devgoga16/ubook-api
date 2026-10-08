import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
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

export class DepositRuleDto {
  @IsBoolean()
  enabled: boolean;

  @IsIn(['percent', 'fixed'])
  type: 'percent' | 'fixed';

  /** Porcentaje 1–100 o monto fijo en céntimos. */
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  value: number;
}

export class CreateServiceDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** `null` = sin categoría. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsMongoId()
  categoryId?: string | null;

  @IsInt()
  @Min(5)
  @Max(720)
  durationMinutes: number;

  /** Céntimos. */
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  price: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  bufferBeforeMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  bufferAfterMinutes?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => DepositRuleDto)
  deposit?: DepositRuleDto;

  @IsOptional()
  @IsBoolean()
  onlineBooking?: boolean;

  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/)
  color?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateServiceDto extends PartialType(CreateServiceDto) {
  @IsOptional()
  @IsBoolean()
  isArchived?: boolean;
}

export class ListServicesQuery {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeArchived?: boolean;
}

export class CategoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateCategoryDto extends PartialType(CategoryDto) {}
