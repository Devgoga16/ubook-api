import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsMongoId, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { Public } from '../../core/auth/decorators.js';
import { ParseObjectIdPipe } from '../../core/common/parse-object-id.pipe.js';
import { MAX_IMAGE_BYTES } from '../../core/storage/storage.service.js';
import { ClientTicketDto, TicketMessageDto } from '../support/support.dto.js';
import { RELATIONSHIPS } from '../clients/schemas/client.schema.js';
import { ClientPortalService } from './client-portal.service.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToNull = ({ value }: { value: unknown }) => (value === '' ? null : value);
/** Celular peruano: 9 dígitos que empiezan con 9. */
const PHONE = /^(\+?51)?\s?9\d{2}\s?\d{3}\s?\d{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class PortalCodeDto {
  @Matches(PHONE, { message: 'Celular inválido' })
  phone: string;
}

class PortalSessionDto extends PortalCodeDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/\s/g, '') : value))
  @Matches(/^\d{6}$/, { message: 'El código tiene 6 dígitos' })
  code: string;
}

class PortalProfileDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Escribe el nombre' })
  @MaxLength(60)
  firstName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  lastName?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() || null : value))
  @ValidateIf((_, v) => v !== null)
  @IsEmail({}, { message: 'Correo inválido' })
  email?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(DATE, { message: 'Fecha inválida' })
  birthDate?: string | null;

  @IsOptional()
  @IsBoolean()
  marketingConsent?: boolean;

  @IsOptional()
  @IsIn(RELATIONSHIPS)
  relationship?: string;
}

class PortalDependentDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Escribe el nombre' })
  @MaxLength(60)
  firstName: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  lastName?: string;

  @IsOptional()
  @Transform(emptyToNull)
  @ValidateIf((_, v) => v !== null)
  @Matches(DATE, { message: 'Fecha inválida' })
  birthDate?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20)
  documentId?: string;

  @IsIn(RELATIONSHIPS, { message: 'Elige el parentesco' })
  relationship: string;

  @IsOptional()
  @IsMongoId()
  guardianId?: string;
}

const CODES = { default: { limit: 5, ttl: 60_000 } };
const BROWSE = { default: { limit: 120, ttl: 60_000 } };
const WRITE = { default: { limit: 20, ttl: 60_000 } };
export const PORTAL_TOKEN_HEADER = 'x-portal-token';

/** Portal del cliente de un negocio: sus citas, su familia, sus pagos y sus datos. */
@Public()
@Controller('public/businesses/:slug/portal')
export class ClientPortalController {
  constructor(private readonly portal: ClientPortalService) {}

  @Throttle(CODES)
  @Post('code')
  @HttpCode(200)
  requestCode(@Param('slug') slug: string, @Body() dto: PortalCodeDto) {
    return this.portal.requestCode(slug, dto.phone);
  }

  @Throttle(CODES)
  @Post('session')
  @HttpCode(200)
  session(@Param('slug') slug: string, @Body() dto: PortalSessionDto) {
    return this.portal.verifyCode(slug, dto.phone, dto.code);
  }

  @Throttle(BROWSE)
  @Get('me')
  me(@Param('slug') slug: string, @Headers(PORTAL_TOKEN_HEADER) token?: string) {
    return this.portal.me(slug, token ?? '');
  }

  @Throttle(BROWSE)
  @Get('appointments')
  appointments(@Param('slug') slug: string, @Headers(PORTAL_TOKEN_HEADER) token?: string) {
    return this.portal.appointmentsOf(slug, token ?? '');
  }

  @Throttle(BROWSE)
  @Get('payments')
  payments(@Param('slug') slug: string, @Headers(PORTAL_TOKEN_HEADER) token?: string) {
    return this.portal.paymentsOf(slug, token ?? '');
  }

  @Throttle(WRITE)
  @Patch('profiles/:clientId')
  update(@Param('slug') slug: string, @Param('clientId', ParseObjectIdPipe) clientId: string, @Body() dto: PortalProfileDto, @Headers(PORTAL_TOKEN_HEADER) token?: string) {
    return this.portal.updateProfile(slug, token ?? '', clientId, dto);
  }

  /** Registra a una persona a cargo del titular. */
  @Throttle(WRITE)
  @Post('dependents')
  addDependent(@Param('slug') slug: string, @Body() dto: PortalDependentDto, @Headers(PORTAL_TOKEN_HEADER) token?: string) {
    return this.portal.addDependent(slug, token ?? '', dto);
  }

  @Throttle(WRITE)
  @Delete('dependents/:clientId')
  removeDependent(@Param('slug') slug: string, @Param('clientId', ParseObjectIdPipe) clientId: string, @Headers(PORTAL_TOKEN_HEADER) token?: string) {
    return this.portal.removeDependent(slug, token ?? '', clientId);
  }

  /* ---------- Ayuda: consultas al negocio o al soporte técnico ---------- */

  @Throttle(BROWSE)
  @Get('help')
  helpList(@Param('slug') slug: string, @Headers(PORTAL_TOKEN_HEADER) token?: string) {
    return this.portal.helpList(slug, token ?? '');
  }

  @Throttle(WRITE)
  @Post('help/attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  helpUpload(@Param('slug') slug: string, @UploadedFile() file?: { buffer: Buffer }, @Headers(PORTAL_TOKEN_HEADER) token?: string) {
    return this.portal.helpUpload(slug, token ?? '', file?.buffer ?? Buffer.alloc(0));
  }

  @Throttle(WRITE)
  @Post('help')
  helpCreate(@Param('slug') slug: string, @Body() dto: ClientTicketDto, @Headers(PORTAL_TOKEN_HEADER) token?: string) {
    return this.portal.helpCreate(slug, token ?? '', dto);
  }

  @Throttle(BROWSE)
  @Get('help/:id')
  helpDetail(@Param('slug') slug: string, @Param('id', ParseObjectIdPipe) id: string, @Headers(PORTAL_TOKEN_HEADER) token?: string) {
    return this.portal.helpDetail(slug, token ?? '', id);
  }

  @Throttle(WRITE)
  @Post('help/:id/messages')
  helpReply(@Param('slug') slug: string, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: TicketMessageDto, @Headers(PORTAL_TOKEN_HEADER) token?: string) {
    return this.portal.helpReply(slug, token ?? '', id, dto);
  }

  @Throttle(WRITE)
  @Post('help/:id/resolve')
  @HttpCode(200)
  helpResolve(@Param('slug') slug: string, @Param('id', ParseObjectIdPipe) id: string, @Headers(PORTAL_TOKEN_HEADER) token?: string) {
    return this.portal.helpResolve(slug, token ?? '', id);
  }
}
