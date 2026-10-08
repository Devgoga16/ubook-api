import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../../core/auth/decorators.js';
import { ParseObjectIdPipe } from '../../core/common/parse-object-id.pipe.js';
import { ClientsService } from './clients.service.js';
import { CreateClientDto, ListClientsQuery, UpdateClientDto } from './dto/client.dto.js';

@Controller('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  /** Búsqueda rápida por nombre, celular, email o documento. */
  @RequirePermission('client.read')
  @Get()
  list(@Query() q: ListClientsQuery) {
    return this.clients.list(q.search, q.limit);
  }

  /** Lista con estadísticas, segmentos y paginación. */
  @RequirePermission('client.read')
  @Get('directory')
  directory(@Query() q: ListClientsQuery) {
    return this.clients.directory({ search: q.search, segment: q.segment, page: q.page, limit: q.limit });
  }

  @RequirePermission('client.read')
  @Get('summary')
  summary() {
    return this.clients.summary();
  }

  @RequirePermission('client.read')
  @Get(':id')
  get(@Param('id', ParseObjectIdPipe) id: string) {
    return this.clients.get(id);
  }

  @RequirePermission('client.create')
  @Post()
  create(@Body() dto: CreateClientDto) {
    return this.clients.create(dto);
  }

  @RequirePermission('client.update')
  @Patch(':id')
  update(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateClientDto) {
    return this.clients.update(id, dto);
  }
}
