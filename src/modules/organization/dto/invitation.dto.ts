import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateInvitationDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'Correo inválido' })
  email: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  firstName: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  lastName?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsMongoId({ each: true })
  roleIds: string[];

  /** Vacío = todas las sucursales. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsMongoId({ each: true })
  branchIds?: string[];

  @IsOptional()
  @IsMongoId()
  professionalId?: string;
}

export class AcceptInvitationDto {
  @IsString()
  @MinLength(20)
  @MaxLength(100)
  token: string;

  /** Cuenta nueva: la contraseña que elige. Cuenta existente: su contraseña actual. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  firstName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  lastName?: string;
}
