import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AllowWhenReadOnly, CurrentActor, RequirePermission } from '../../core/auth/decorators.js';
import { ParseObjectIdPipe } from '../../core/common/parse-object-id.pipe.js';
import { MAX_IMAGE_BYTES } from '../../core/storage/storage.service.js';
import { TenantContext, type Actor } from '../../core/tenancy/tenant-context.js';
import { SupportTicketsService } from './support-tickets.service.js';
import { CreateTicketDto, InquiryStatusDto, ListInquiriesQuery, ListMyTicketsQuery, TicketMessageDto } from './support.dto.js';

/**
 * Soporte desde el panel del negocio. Lo usa cualquier miembro del equipo y
 * funciona aunque la suscripción esté vencida o el negocio suspendido: es
 * justo cuando más se necesita escribir a soporte.
 */
@AllowWhenReadOnly()
@Controller('support')
export class SupportController {
  constructor(private readonly tickets: SupportTicketsService) {}

  @Get('tickets')
  list(@CurrentActor() actor: Actor, @Query() query: ListMyTicketsQuery) {
    return this.tickets.listForOrganization(actor, query.scope);
  }

  @Get('tickets/unread')
  unread(@CurrentActor() actor: Actor) {
    return this.tickets.unreadCount(actor);
  }

  /** Captura de pantalla (campo "file"); devuelve la clave para adjuntarla a un mensaje. */
  @Post('attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  upload(@UploadedFile() file?: { buffer: Buffer }) {
    return this.tickets.uploadAttachment(TenantContext.requireOrganizationId(), file?.buffer ?? Buffer.alloc(0));
  }

  @Post('tickets')
  create(@CurrentActor() actor: Actor, @Body() dto: CreateTicketDto) {
    return this.tickets.create(actor, dto);
  }

  @Get('tickets/:id')
  detail(@CurrentActor() actor: Actor, @Param('id', ParseObjectIdPipe) id: string) {
    return this.tickets.getForOrganization(actor, id);
  }

  @Post('tickets/:id/messages')
  reply(@CurrentActor() actor: Actor, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: TicketMessageDto) {
    return this.tickets.reply(actor, id, { ...dto, internal: false });
  }

  @Post('tickets/:id/resolve')
  @HttpCode(200)
  resolve(@CurrentActor() actor: Actor, @Param('id', ParseObjectIdPipe) id: string) {
    return this.tickets.resolveByCustomer(actor, id);
  }
}

/** Consultas que los clientes finales le hacen al negocio desde su portal. */
@Controller('support/inquiries')
export class ClientInquiriesController {
  constructor(private readonly tickets: SupportTicketsService) {}

  @RequirePermission('client.read')
  @Get()
  list(@Query() query: ListInquiriesQuery) {
    return this.tickets.listInquiries(query.status);
  }

  @RequirePermission('client.read')
  @Get('unread')
  unread() {
    return this.tickets.inquiriesUnread();
  }

  @RequirePermission('client.read')
  @Get(':id')
  detail(@CurrentActor() actor: Actor, @Param('id', ParseObjectIdPipe) id: string) {
    return this.tickets.getInquiry(actor, id);
  }

  @RequirePermission('client.read')
  @Post(':id/messages')
  reply(@CurrentActor() actor: Actor, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: TicketMessageDto) {
    return this.tickets.replyToInquiry(actor, id, dto);
  }

  @RequirePermission('client.read')
  @Patch(':id')
  setStatus(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: InquiryStatusDto) {
    return this.tickets.setInquiryStatus(id, dto.status);
  }
}
