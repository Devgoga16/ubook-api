import { Type } from 'class-transformer';
import {
  IsEmail,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CreateOrganizationDto } from '../../organization/dto/organization.dto.js';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MaxLength(200)
  password: string;
}

/** Registro de un negocio nuevo: crea la cuenta del dueño y su organización. */
export class RegisterDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  firstName: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  lastName: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @Matches(/^\+?[0-9 ()-]{6,20}$/)
  phone?: string;

  /** Mínimo 10 caracteres con letras y números. */
  @IsString()
  @MinLength(10)
  @MaxLength(200)
  @Matches(/(?=.*[A-Za-z])(?=.*\d)/, { message: 'La contraseña debe incluir letras y números' })
  password: string;

  @ValidateNested()
  @Type(() => CreateOrganizationDto)
  organization: CreateOrganizationDto;
}

export class SwitchOrganizationDto {
  @IsMongoId()
  organizationId: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  email: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token: string;

  /** Misma regla que al registrarse. */
  @IsString()
  @MinLength(10)
  @MaxLength(200)
  @Matches(/(?=.*[A-Za-z])(?=.*\d)/, { message: 'La contraseña debe incluir letras y números' })
  password: string;
}
