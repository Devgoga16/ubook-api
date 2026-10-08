import { PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
} from 'class-validator';
import { CONTACT_CHANNELS, type ContactChannel } from '../schemas/client.schema.js';

export class CreateClientDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  firstName: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  lastName?: string;

  /** Celular peruano: 9 dígitos que empiezan con 9, con o sin +51. */
  @IsOptional()
  @Matches(/^(\+?51)?\s?9\d{2}\s?\d{3}\s?\d{3}$/, { message: 'Celular inválido' })
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  birthDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  documentId?: string;

  /** Confirmación de que es otra persona con el mismo celular (p. ej. hijo y mamá). */
  @IsOptional()
  @IsBoolean()
  allowSharedPhone?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  source?: string;

  @IsOptional()
  @IsIn(CONTACT_CHANNELS)
  preferredChannel?: ContactChannel;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsMongoId()
  preferredProfessionalId?: string | null;

  @IsOptional()
  @IsBoolean()
  marketingConsent?: boolean;

  /** `true` registra el consentimiento ahora; `false` lo retira. */
  @IsOptional()
  @IsBoolean()
  dataConsent?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  tags?: string[];
}

export class UpdateClientDto extends PartialType(CreateClientDto) {}

export const CLIENT_SEGMENTS = ['all', 'new', 'upcoming', 'at_risk', 'vip'] as const;
export type ClientSegment = (typeof CLIENT_SEGMENTS)[number];

export class ListClientsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  @IsOptional()
  @IsIn(CLIENT_SEGMENTS)
  segment?: ClientSegment;

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
  limit?: number;

  /** Incluir visitas, gasto, última visita y próxima cita. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  withStats?: boolean;
}
