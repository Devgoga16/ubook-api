import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Service, ServiceSchema } from '../catalog/schemas/service.schema.js';
import { Branch, BranchSchema } from '../organization/schemas/branch.schema.js';
import { Membership, MembershipSchema } from '../organization/schemas/membership.schema.js';
import { PlatformModule } from '../platform/platform.module.js';
import { ProfessionalsController } from './professionals.controller.js';
import { ProfessionalsService } from './professionals.service.js';
import { Professional, ProfessionalSchema } from './schemas/professional.schema.js';
import { TimeOff, TimeOffSchema } from './schemas/time-off.schema.js';

/** Profesionales, sus horarios y ausencias. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Professional.name, schema: ProfessionalSchema },
      { name: TimeOff.name, schema: TimeOffSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: Service.name, schema: ServiceSchema },
      { name: Membership.name, schema: MembershipSchema },
    ]),
    PlatformModule,
  ],
  controllers: [ProfessionalsController],
  providers: [ProfessionalsService],
  exports: [ProfessionalsService],
})
export class ProfessionalsModule {}
