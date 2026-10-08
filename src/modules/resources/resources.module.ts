import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Model } from 'mongoose';
import { AuditService } from '../../core/audit/audit.service.js';
import { RequireFeature, RequirePermission } from '../../core/auth/decorators.js';
import { canActOn } from '../../core/authorization/scope.js';
import { Errors } from '../../core/common/errors.js';
import { ParseObjectIdPipe } from '../../core/common/parse-object-id.pipe.js';
import { addDays, utcToZoned, zonedToUtc } from '../../core/scheduling/zoned-time.js';
import { Appointment, AppointmentSchema, BLOCKING_STATUSES } from '../bookings/schemas/appointment.schema.js';
import { Service, ServiceSchema } from '../catalog/schemas/service.schema.js';
import { Branch, BranchSchema } from '../organization/schemas/branch.schema.js';
import { Resource, ResourceSchema, type ResourceDocument } from './resource.schema.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class ResourceDto {
  @IsMongoId()
  branchId: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  kind?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  capacity?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsMongoId({ each: true })
  serviceIds?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

class UpdateResourceDto extends PartialType(ResourceDto) {}

class ResourcesQuery {
  @IsMongoId()
  branchId: string;
}

@Injectable()
class ResourcesService {
  constructor(
    @InjectModel(Resource.name) private readonly resources: Model<Resource>,
    @InjectModel(Appointment.name) private readonly appointments: Model<Appointment>,
    @InjectModel(Branch.name) private readonly branches: Model<Branch>,
    @InjectModel(Service.name) private readonly services: Model<Service>,
    private readonly audit: AuditService,
  ) {}

  /** Recursos de la sede con su uso de hoy (bloques ocupados). */
  async list(branchId: string) {
    if (!canActOn('resource.read', { branchIds: [branchId] })) throw Errors.forbidden();
    const branch = await this.branches.findById(branchId).select('timezone').exec();
    if (!branch) throw Errors.notFound('Sucursal');
    const docs = await this.resources.find({ branchId }).sort({ isActive: -1, name: 1 }).exec();
    const today = utcToZoned(new Date(), branch.timezone).date;
    const start = zonedToUtc(today, 0, branch.timezone);
    const end = zonedToUtc(addDays(today, 1), 0, branch.timezone);
    const busy = await this.appointments
      .find({ resourceId: { $in: docs.map((d) => d._id) }, status: { $in: BLOCKING_STATUSES }, startsAt: { $gte: start, $lt: end } })
      .select('resourceId startsAt endsAt')
      .exec();
    return docs.map((d) => ({
      ...d.toJSON(),
      today: busy
        .filter((a) => a.resourceId?.equals(d._id))
        .map((a) => ({ startMinute: utcToZoned(a.startsAt, branch.timezone).minutes, endMinute: utcToZoned(a.endsAt, branch.timezone).minutes }))
        .sort((a, b) => a.startMinute - b.startMinute),
    }));
  }

  async create(dto: ResourceDto): Promise<ResourceDocument> {
    await this.validate(dto.branchId, dto.serviceIds);
    const r = await this.resources.create(dto);
    await this.audit.log({ action: 'resource.created', entityType: 'Resource', entityId: r.id as string });
    return r;
  }

  async update(id: string, dto: UpdateResourceDto): Promise<ResourceDocument> {
    const r = await this.resources.findById(id).exec();
    if (!r) throw Errors.notFound('Recurso');
    await this.validate(dto.branchId ?? r.branchId.toString(), dto.serviceIds);
    r.set(dto);
    await r.save();
    await this.audit.log({ action: 'resource.updated', entityType: 'Resource', entityId: id });
    return r;
  }

  private async validate(branchId: string, serviceIds?: string[]) {
    if (!canActOn('resource.manage', { branchIds: [branchId] })) throw Errors.forbidden();
    if (!(await this.branches.exists({ _id: branchId }))) throw Errors.badRequest('INVALID_BRANCH', 'Sucursal inválida');
    if (serviceIds?.length && (await this.services.countDocuments({ _id: { $in: serviceIds } })) !== serviceIds.length) {
      throw Errors.badRequest('INVALID_SERVICE', 'Servicio inválido');
    }
  }
}

/** Recursos: salas, camillas, sillones o equipos (plan Pro y Business). */
@RequireFeature('resources')
@Controller('resources')
class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @RequirePermission('resource.read')
  @Get()
  list(@Query() q: ResourcesQuery) {
    return this.resources.list(q.branchId);
  }

  @RequirePermission('resource.manage')
  @Post()
  create(@Body() dto: ResourceDto) {
    return this.resources.create(dto);
  }

  @RequirePermission('resource.manage')
  @Patch(':id')
  update(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateResourceDto) {
    return this.resources.update(id, dto);
  }
}

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Resource.name, schema: ResourceSchema },
      { name: Appointment.name, schema: AppointmentSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: Service.name, schema: ServiceSchema },
    ]),
  ],
  controllers: [ResourcesController],
  providers: [ResourcesService],
})
export class ResourcesModule {}

