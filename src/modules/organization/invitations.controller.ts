import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RequirePermission } from '../../core/auth/decorators.js';
import { ParseObjectIdPipe } from '../../core/common/parse-object-id.pipe.js';
import { CreateInvitationDto } from './dto/invitation.dto.js';
import { InvitationsService, type InvitationCreated } from './invitations.service.js';

const view = ({ invitation, inviteUrl, emailSent }: InvitationCreated) => ({ ...invitation.toJSON(), inviteUrl, emailSent });

/** Invitaciones al equipo (la aceptación pública está en /auth). */
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @RequirePermission('member.read')
  @Get()
  list() {
    return this.invitations.listPending();
  }

  @RequirePermission('member.manage')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  async create(@Body() dto: CreateInvitationDto) {
    return view(await this.invitations.create(dto));
  }

  @RequirePermission('member.manage')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':id/resend')
  @HttpCode(200)
  async resend(@Param('id', ParseObjectIdPipe) id: string) {
    return view(await this.invitations.resend(id));
  }

  @RequirePermission('member.manage')
  @Delete(':id')
  @HttpCode(204)
  revoke(@Param('id', ParseObjectIdPipe) id: string) {
    return this.invitations.revoke(id);
  }
}
