import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../../core/auth/decorators.js';
import { ParseObjectIdPipe } from '../../core/common/parse-object-id.pipe.js';
import {
  CategoryDto,
  CreateServiceDto,
  ListServicesQuery,
  UpdateCategoryDto,
  UpdateServiceDto,
} from './dto/service.dto.js';
import { ServicesService } from './services.service.js';

@Controller()
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @RequirePermission('service.read')
  @Get('services')
  list(@Query() query: ListServicesQuery) {
    return this.services.list(query.includeArchived);
  }

  @RequirePermission('service.read')
  @Get('services/:id')
  get(@Param('id', ParseObjectIdPipe) id: string) {
    return this.services.get(id);
  }

  @RequirePermission('service.manage')
  @Post('services')
  create(@Body() dto: CreateServiceDto) {
    return this.services.create(dto);
  }

  @RequirePermission('service.manage')
  @Patch('services/:id')
  update(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateServiceDto) {
    return this.services.update(id, dto);
  }

  @RequirePermission('service.read')
  @Get('service-categories')
  listCategories() {
    return this.services.listCategories();
  }

  @RequirePermission('service.manage')
  @Post('service-categories')
  createCategory(@Body() dto: CategoryDto) {
    return this.services.createCategory(dto);
  }

  @RequirePermission('service.manage')
  @Patch('service-categories/:id')
  updateCategory(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateCategoryDto) {
    return this.services.updateCategory(id, dto);
  }

  @RequirePermission('service.manage')
  @Delete('service-categories/:id')
  @HttpCode(204)
  removeCategory(@Param('id', ParseObjectIdPipe) id: string) {
    return this.services.removeCategory(id);
  }
}
