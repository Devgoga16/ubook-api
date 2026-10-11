import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import type { PlatformRole } from '../../core/tenancy/tenant-context.js';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES, type TicketCategory, type TicketPriority, type TicketStatus } from './support.schemas.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const MAX_ATTACHMENTS = 4;

class TicketContextDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  path?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  userAgent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  viewport?: string;
}

export class CreateTicketDto {
  @Transform(trim)
  @IsString()
  @MinLength(4, { message: 'Escribe un asunto' })
  @MaxLength(140)
  subject: string;

  @IsIn(TICKET_CATEGORIES)
  category: TicketCategory;

  @Transform(trim)
  @IsString()
  @MinLength(10, { message: 'Cuéntanos qué pasó con un poco más de detalle' })
  @MaxLength(5000)
  body: string;

  /** Claves que devolvió POST /support/attachments. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ATTACHMENTS)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  attachments?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => TicketContextDto)
  context?: TicketContextDto;
}

export class TicketMessageDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Escribe un mensaje' })
  @MaxLength(5000)
  body: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ATTACHMENTS)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  attachments?: string[];

  /** Solo plataforma: nota interna que el negocio no ve. */
  @IsOptional()
  @IsBoolean()
  internal?: boolean;
}

export class ListMyTicketsQuery {
  /** `all` = todos los del negocio (solo quien administra el negocio). */
  @IsOptional()
  @IsIn(['mine', 'all'])
  scope?: 'mine' | 'all';
}

export class ListPlatformTicketsQuery {
  /** `active` = todo lo que no está resuelto. */
  @IsOptional()
  @IsIn([...TICKET_STATUSES, 'active'])
  status?: TicketStatus | 'active';

  /** `me`, `none` (sin asignar) o el id de un agente. */
  @IsOptional()
  @IsString()
  @MaxLength(24)
  assignee?: string;

  @IsOptional()
  @IsIn(TICKET_PRIORITIES)
  priority?: TicketPriority;

  @IsOptional()
  @IsMongoId()
  organizationId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  search?: string;

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
}

export class UpdateTicketDto {
  @IsOptional()
  @IsIn(TICKET_STATUSES)
  status?: TicketStatus;

  @IsOptional()
  @IsIn(TICKET_PRIORITIES)
  priority?: TicketPriority;

  @IsOptional()
  @IsIn(TICKET_CATEGORIES)
  category?: TicketCategory;

  /** `null` deja el ticket sin asignar. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsMongoId()
  assignedToUserId?: string | null;
}

export class SupportViewDto {
  /** Ticket que motiva el acceso; queda en la auditoría del negocio. */
  @IsOptional()
  @IsMongoId()
  ticketId?: string;
}

/* ---------- Clientes finales (portal) ---------- */

/** `technical` va al soporte de uBook; el resto lo atiende el negocio. */
export const CLIENT_TOPICS = ['appointment', 'payment', 'service', 'other', 'technical'] as const;
export type ClientTopic = (typeof CLIENT_TOPICS)[number];

export class ClientTicketDto {
  @IsIn(CLIENT_TOPICS, { message: 'Elige el tema' })
  topic: ClientTopic;

  @Transform(trim)
  @IsString()
  @MinLength(4, { message: 'Escribe un asunto' })
  @MaxLength(140)
  subject: string;

  @Transform(trim)
  @IsString()
  @MinLength(5, { message: 'Cuéntanos un poco más' })
  @MaxLength(5000)
  body: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ATTACHMENTS)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  attachments?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => TicketContextDto)
  context?: TicketContextDto;
}

export class ListInquiriesQuery {
  @IsOptional()
  @IsIn(['active', 'resolved'])
  status?: 'active' | 'resolved';
}

export class InquiryStatusDto {
  @IsIn(['open', 'resolved'])
  status: 'open' | 'resolved';
}

/* ---------- Equipo de plataforma ---------- */

const PLATFORM_ROLES: PlatformRole[] = ['super_admin', 'support'];

export class InvitePlatformUserDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  firstName: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  lastName: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'Correo inválido' })
  email: string;

  @IsOptional()
  @IsIn(PLATFORM_ROLES)
  role?: PlatformRole;
}

export class UpdatePlatformUserDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  firstName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  lastName?: string;

  @IsOptional()
  @IsIn(PLATFORM_ROLES)
  role?: PlatformRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
