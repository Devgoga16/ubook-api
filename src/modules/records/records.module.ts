import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FieldCryptoService } from '../../core/security/field-crypto.service.js';
import { Appointment, AppointmentSchema } from '../bookings/schemas/appointment.schema.js';
import { Client, ClientSchema } from '../clients/schemas/client.schema.js';
import { Professional, ProfessionalSchema } from '../professionals/schemas/professional.schema.js';
import { RecordsController } from './records.controller.js';
import { RecordsService } from './records.service.js';
import { ClientRecord, ClientRecordSchema, RecordTemplate, RecordTemplateSchema } from './schemas/record.schemas.js';

/** Fichas clínicas: plantillas por negocio y entradas cifradas por cliente. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RecordTemplate.name, schema: RecordTemplateSchema },
      { name: ClientRecord.name, schema: ClientRecordSchema },
      { name: Client.name, schema: ClientSchema },
      { name: Appointment.name, schema: AppointmentSchema },
      { name: Professional.name, schema: ProfessionalSchema },
    ]),
  ],
  controllers: [RecordsController],
  providers: [RecordsService, FieldCryptoService],
})
export class RecordsModule {}
