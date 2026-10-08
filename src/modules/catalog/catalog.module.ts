import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ServiceCategory, ServiceCategorySchema } from './schemas/service-category.schema.js';
import { Service, ServiceSchema } from './schemas/service.schema.js';
import { ServicesController } from './services.controller.js';
import { ServicesService } from './services.service.js';

/** Catálogo: servicios y categorías (luego recursos). */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Service.name, schema: ServiceSchema },
      { name: ServiceCategory.name, schema: ServiceCategorySchema },
    ]),
  ],
  controllers: [ServicesController],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class CatalogModule {}
