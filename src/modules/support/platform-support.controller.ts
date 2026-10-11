import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AllowContexts, CurrentActor, PlatformOnly } from '../../core/auth/decorators.js';
import { ParseObjectIdPipe } from '../../core/common/parse-object-id.pipe.js';
import { MAX_IMAGE_BYTES } from '../../core/storage/storage.service.js';
import type { Actor } from '../../core/tenancy/tenant-context.js';
import { PlatformTeamService } from './platform-team.service.js';
import { SupportTicketsService } from './support-tickets.service.js';
import { InvitePlatformUserDto, ListPlatformTicketsQuery, SupportViewDto, TicketMessageDto, UpdatePlatformUserDto, UpdateTicketDto } from './support.dto.js';

/** Bandeja de tickets del equipo de Unify Tec (super admin y soporte). */
@AllowContexts('platform')
@PlatformOnly('super_admin', 'support')
@Controller('platform/support')
export class PlatformSupportController {
  constructor(private readonly tickets: SupportTicketsService) {}

  @Get('tickets')
  list(@CurrentActor() actor: Actor, @Query() query: ListPlatformTicketsQuery) {
    return this.tickets.listForPlatform(actor, query);
  }

  @Get('summary')
  summary(@CurrentActor() actor: Actor) {
    return this.tickets.summary(actor);
  }

  @Get('agents')
  agents() {
    return this.tickets.agents();
  }

  @Get('tickets/:id')
  detail(@Param('id', ParseObjectIdPipe) id: string) {
    return this.tickets.getForPlatform(id);
  }

  @Patch('tickets/:id')
  update(@CurrentActor() actor: Actor, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateTicketDto) {
    return this.tickets.update(actor, id, dto);
  }

  @Post('tickets/:id/messages')
  reply(@CurrentActor() actor: Actor, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: TicketMessageDto) {
    return this.tickets.replyAsAgent(actor, id, dto);
  }

  @Post('tickets/:id/attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  upload(@Param('id', ParseObjectIdPipe) id: string, @UploadedFile() file?: { buffer: Buffer }) {
    return this.tickets.uploadAgentAttachment(id, file?.buffer ?? Buffer.alloc(0));
  }

  /** Entra al negocio en solo lectura para diagnosticar ("ver como el negocio"). */
  @Post('organizations/:id/view')
  @HttpCode(200)
  view(@CurrentActor() actor: Actor, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: SupportViewDto) {
    return this.tickets.startSupportView(actor, id, dto.ticketId);
  }
}

/** Quién forma parte del equipo de plataforma. Solo el super admin lo gestiona. */
@AllowContexts('platform')
@PlatformOnly('super_admin')
@Controller('platform/team')
export class PlatformTeamController {
  constructor(private readonly team: PlatformTeamService) {}

  @Get()
  list() {
    return this.team.list();
  }

  @Post()
  invite(@CurrentActor() actor: Actor, @Body() dto: InvitePlatformUserDto) {
    return this.team.invite(actor, dto);
  }

  @Post(':id/resend')
  @HttpCode(200)
  resend(@CurrentActor() actor: Actor, @Param('id', ParseObjectIdPipe) id: string) {
    return this.team.resend(actor, id);
  }

  @Patch(':id')
  update(@CurrentActor() actor: Actor, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdatePlatformUserDto) {
    return this.team.update(actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentActor() actor: Actor, @Param('id', ParseObjectIdPipe) id: string) {
    await this.team.remove(actor, id);
  }
}
