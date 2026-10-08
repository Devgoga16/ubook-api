import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument, Types } from 'mongoose';
import { tenantPlugin } from '../../../core/database/tenant.plugin.js';
import { DayScheduleEntry } from '../../../core/scheduling/weekly-schedule.schema.js';

@Schema({ timestamps: true, collection: 'branches' })
export class Branch {
  organizationId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  /** Zona horaria IANA (America/Lima). Las fechas se guardan en UTC. */
  @Prop({ required: true })
  timezone: string;

  @Prop({ trim: true })
  address?: string;

  @Prop({ trim: true })
  phone?: string;

  /** Referencia para llegar ("frente al parque Kennedy, 2.º piso"). */
  @Prop({ trim: true })
  reference?: string;

  /** Enlace de Google Maps. */
  @Prop({ trim: true })
  mapsUrl?: string;

  @Prop({ default: true })
  isActive: boolean;

  /**
   * Horario de atención (hora local de la sede). Vacío = sin definir: no
   * limita la agenda más allá del horario de cada profesional.
   */
  @Prop({ type: [DayScheduleEntry], default: [] })
  openingHours: DayScheduleEntry[];
}

export type BranchDocument = HydratedDocument<Branch>;
export const BranchSchema = SchemaFactory.createForClass(Branch);
BranchSchema.plugin(tenantPlugin);
