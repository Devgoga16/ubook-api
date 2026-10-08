import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument, Types } from 'mongoose';
import { tenantPlugin } from '../../../core/database/tenant.plugin.js';

/** Agrupa servicios (Cortes, Barba, Color…). */
@Schema({ timestamps: true, collection: 'service_categories' })
export class ServiceCategory {
  organizationId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ default: 0 })
  sortOrder: number;
}

export type ServiceCategoryDocument = HydratedDocument<ServiceCategory>;
export const ServiceCategorySchema = SchemaFactory.createForClass(ServiceCategory);
ServiceCategorySchema.plugin(tenantPlugin);
ServiceCategorySchema.index({ organizationId: 1, name: 1 }, { unique: true });
