import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { FeatureValue } from '../features.catalog.js';

export class PlanPriceDto {
  @IsInt()
  @Min(0)
  monthly: number;

  @IsInt()
  @Min(0)
  yearly: number;

  @IsString()
  @Length(3, 3)
  currency: string;
}

export class CreatePlanDto {
  @Matches(/^[a-z0-9_-]{2,40}$/)
  code: string;

  @IsString()
  @MaxLength(60)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ValidateNested()
  @Type(() => PlanPriceDto)
  price: PlanPriceDto;

  /** `{ max_professionals: 10, client_portal: true }` — se valida contra el catálogo. */
  @IsOptional()
  @IsObject()
  features?: Record<string, FeatureValue>;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdatePlanDto extends PartialType(CreatePlanDto) {}
