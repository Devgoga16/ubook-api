import { Type } from 'class-transformer';
import { PartialType, PickType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsISO31661Alpha2,
  IsISO4217CurrencyCode,
  IsOptional,
  IsString,
  IsTimeZone,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateOrganizationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  /** Zona horaria IANA. Por defecto America/Lima. */
  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  @IsOptional()
  @IsISO31661Alpha2()
  country?: string;

  @IsOptional()
  @IsISO4217CurrencyCode()
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  businessType?: string;

  /** Plan con el que inicia la prueba gratis. */
  @IsOptional()
  @Matches(/^[a-z0-9_-]{2,40}$/)
  planCode?: string;

  /** El dueño también atiende: se crea su perfil de profesional vinculado a su usuario. */
  @IsOptional()
  @IsBoolean()
  ownerAttends?: boolean;
}

export class DepositInfoDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  yape?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  plin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  bank?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  notes?: string;
}

export class UpdateOrganizationDto extends PartialType(
  PickType(CreateOrganizationDto, ['name', 'timezone', 'country', 'currency', 'businessType'] as const),
) {
  /** Datos para que el cliente pague el adelanto. */
  @IsOptional()
  @ValidateNested()
  @Type(() => DepositInfoDto)
  depositInfo?: DepositInfoDto;

  @IsOptional()
  @Matches(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/, {
    message: 'El slug solo admite minúsculas, números y guiones',
  })
  slug?: string;
}
