import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../../core/auth/decorators.js';
import { ParseObjectIdPipe } from '../../core/common/parse-object-id.pipe.js';
import { BookFromWaitlistDto, CreateWaitlistDto, ListWaitlistQuery, UpdateWaitlistDto } from './dto/waitlist.dto.js';
import { WaitlistService } from './waitlist.service.js';

@Controller('waitlist')
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @RequirePermission('booking.read')
  @Get()
  list(@Query() q: ListWaitlistQuery) {
    return this.waitlist.list(q.branchId, q.status);
  }

  @RequirePermission('booking.create')
  @Post()
  async create(@Body() dto: CreateWaitlistDto) {
    const entry = await this.waitlist.create(dto);
    return { id: entry.id as string };
  }

  @RequirePermission('booking.create')
  @Patch(':id')
  update(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateWaitlistDto) {
    return this.waitlist.update(id, dto);
  }

  @RequirePermission('booking.create')
  @Post(':id/book')
  book(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: BookFromWaitlistDto) {
    return this.waitlist.book(id, dto.professionalId, dto.startsAt);
  }

  @RequirePermission('booking.read')
  @Post(':id/notify')
  notify(@Param('id', ParseObjectIdPipe) id: string) {
    return this.waitlist.notify(id);
  }
}
