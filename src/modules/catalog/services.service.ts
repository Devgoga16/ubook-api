import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AuditService } from '../../core/audit/audit.service.js';
import { Errors } from '../../core/common/errors.js';
import type {
  CategoryDto,
  CreateServiceDto,
  DepositRuleDto,
  UpdateCategoryDto,
  UpdateServiceDto,
} from './dto/service.dto.js';
import { ServiceCategory, type ServiceCategoryDocument } from './schemas/service-category.schema.js';
import { Service, type ServiceDocument } from './schemas/service.schema.js';

@Injectable()
export class ServicesService {
  constructor(
    @InjectModel(Service.name) private readonly services: Model<Service>,
    @InjectModel(ServiceCategory.name) private readonly categories: Model<ServiceCategory>,
    private readonly audit: AuditService,
  ) {}

  /* ---------- Servicios ---------- */

  list(includeArchived = false): Promise<ServiceDocument[]> {
    return this.services
      .find(includeArchived ? {} : { isArchived: false })
      .sort({ sortOrder: 1, name: 1 })
      .exec();
  }

  async get(id: string): Promise<ServiceDocument> {
    const service = await this.services.findById(id).exec();
    if (!service) throw Errors.notFound('Servicio');
    return service;
  }

  async create(dto: CreateServiceDto): Promise<ServiceDocument> {
    await this.assertCategory(dto.categoryId);
    assertDeposit(dto.deposit);
    const service = await this.services.create(dto);
    await this.audit.log({ action: 'service.created', entityType: 'Service', entityId: service.id as string });
    return service;
  }

  async update(id: string, dto: UpdateServiceDto): Promise<ServiceDocument> {
    const service = await this.get(id);
    if (dto.categoryId !== undefined) await this.assertCategory(dto.categoryId);
    assertDeposit(dto.deposit);
    service.set(dto);
    await service.save();
    await this.audit.log({
      action: dto.isArchived === true ? 'service.archived' : 'service.updated',
      entityType: 'Service',
      entityId: id,
      metadata: { fields: Object.keys(dto) },
    });
    return service;
  }

  /* ---------- Categorías ---------- */

  listCategories(): Promise<ServiceCategoryDocument[]> {
    return this.categories.find().sort({ sortOrder: 1, name: 1 }).exec();
  }

  async createCategory(dto: CategoryDto): Promise<ServiceCategoryDocument> {
    await this.assertCategoryNameFree(dto.name);
    return this.categories.create(dto);
  }

  async updateCategory(id: string, dto: UpdateCategoryDto): Promise<ServiceCategoryDocument> {
    const category = await this.categories.findById(id).exec();
    if (!category) throw Errors.notFound('Categoría');
    if (dto.name && dto.name !== category.name) await this.assertCategoryNameFree(dto.name);
    category.set(dto);
    return category.save();
  }

  /** Los servicios de la categoría quedan sin categoría. */
  async removeCategory(id: string): Promise<void> {
    const category = await this.categories.findById(id).exec();
    if (!category) throw Errors.notFound('Categoría');
    await this.services.updateMany({ categoryId: category._id }, { categoryId: null }).exec();
    await category.deleteOne();
  }

  private async assertCategory(categoryId: string | null | undefined): Promise<void> {
    if (!categoryId) return;
    if (!(await this.categories.exists({ _id: categoryId }))) {
      throw Errors.badRequest('INVALID_CATEGORY', 'La categoría no existe');
    }
  }

  private async assertCategoryNameFree(name: string): Promise<void> {
    if (await this.categories.exists({ name })) {
      throw Errors.conflict('CATEGORY_NAME_TAKEN', 'Ya existe una categoría con ese nombre');
    }
  }
}

function assertDeposit(deposit?: DepositRuleDto): void {
  if (deposit?.enabled && deposit.type === 'percent' && (deposit.value < 1 || deposit.value > 100)) {
    throw Errors.badRequest('INVALID_DEPOSIT', 'El porcentaje de depósito debe estar entre 1 y 100');
  }
}
