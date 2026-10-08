import { Transform, Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsDate,
  IsEmail,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class PublicSlotsQuery {
  @IsMongoId()
  branchId: string;

  @IsMongoId()
  serviceId: string;

  /** Sin profesional = cualquiera disponible. */
  @IsOptional()
  @IsMongoId()
  professionalId?: string;

  @Matches(DATE)
  date: string;
}

export class PublicDaysQuery {
  @IsMongoId()
  branchId: string;

  @IsMongoId()
  serviceId: string;

  @IsOptional()
  @IsMongoId()
  professionalId?: string;

  @Matches(DATE)
  from: string;

  @Matches(DATE)
  to: string;
}

export class PublicClientDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Escribe tu nombre' })
  @MaxLength(60)
  firstName: string;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Escribe tu apellido' })
  @MaxLength(60)
  lastName: string;

  /** Celular peruano: 9 dígitos que empiezan con 9. */
  @Matches(/^(\+?51)?\s?9\d{2}\s?\d{3}\s?\d{3}$/, { message: 'Celular inválido' })
  phone: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined))
  @IsEmail({}, { message: 'Correo inválido' })
  email?: string;
}

export class DepositSubmissionDto {
  /** Clave que devolvió la subida del comprobante. */
  @IsString()
  @MaxLength(200)
  proofKey: string;

  @IsIn(['yape', 'plin', 'transfer', 'other'])
  method: 'yape' | 'plin' | 'transfer' | 'other';

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  reference?: string;
}

export class PublicBookingDto {
  @IsMongoId()
  branchId: string;

  @IsMongoId()
  serviceId: string;

  /** Sin profesional = se asigna uno disponible. */
  @IsOptional()
  @IsMongoId()
  professionalId?: string;

  @Type(() => Date)
  @IsDate()
  startsAt: Date;

  @ValidateNested()
  @Type(() => PublicClientDto)
  client: PublicClientDto;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;

  /** Aceptó el tratamiento de sus datos para gestionar la cita (Ley 29733). */
  @Equals(true, { message: 'Debes aceptar el uso de tus datos para reservar' })
  acceptsTerms: boolean;

  @IsOptional()
  @IsBoolean()
  marketingConsent?: boolean;

  /** Cupón de descuento. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(24)
  promoCode?: string;

  /** Obligatorio si el servicio pide adelanto. */
  @IsOptional()
  @ValidateNested()
  @Type(() => DepositSubmissionDto)
  deposit?: DepositSubmissionDto;
}

export class PromoQuery {
  @IsMongoId()
  serviceId: string;
}

export class ManageSlotsQuery {
  @Matches(DATE)
  date: string;
}

export class ManageDaysQuery {
  @Matches(DATE)
  from: string;

  @Matches(DATE)
  to: string;
}

export class CancelBookingDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class RescheduleBookingDto {
  @Type(() => Date)
  @IsDate()
  startsAt: Date;
}
