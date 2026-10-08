import { Type } from 'class-transformer';
import { IsDate, IsEmail, IsIn, IsInt, IsObject, IsOptional, IsString, IsTimeZone, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import {
  SUBSCRIPTION_STATUSES,
  type BillingCycle,
  type SubscriptionStatus,
} from '../platform/schemas/subscription.schema.js';
import type { FeatureValue } from '../platform/features.catalog.js';

export class DeleteOrganizationDto {
  /** El slug del negocio, escrito a mano para confirmar. */
  @IsString()
  @MaxLength(80)
  confirm: string;
}

export class ListOrganizationsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;
}

export class UpdateSubscriptionDto {
  @IsOptional()
  @Matches(/^[a-z0-9_-]{2,40}$/)
  planCode?: string;

  @IsOptional()
  @IsIn(SUBSCRIPTION_STATUSES)
  status?: SubscriptionStatus;

  @IsOptional()
  @IsIn(['monthly', 'yearly'])
  billingCycle?: BillingCycle;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  trialEndsAt?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  currentPeriodEnd?: Date;

  /** `{ max_professionals: 12 }`; `null` quita la excepción. */
  @IsOptional()
  @IsObject()
  overrides?: Record<string, FeatureValue | null>;
}

export class UpdateOrganizationStatusDto {
  @IsIn(['active', 'suspended'])
  status: 'active' | 'suspended';
}

export class PlatformUpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  /** Dirección de la página de reservas: /reservar/{slug}. */
  @IsOptional()
  @Matches(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/, { message: 'Solo minúsculas, números y guiones' })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  businessType?: string;

  @IsOptional()
  @IsTimeZone()
  timezone?: string;
}

export class PlatformUpdateOwnerDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  lastName?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Correo inválido' })
  email?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(/^\+?[0-9 ()-]{6,20}$/, { message: 'Celular inválido' })
  phone?: string | null;
}
