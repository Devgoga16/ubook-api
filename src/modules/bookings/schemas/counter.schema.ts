import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { Types } from 'mongoose';
import { tenantPlugin } from '../../../core/database/tenant.plugin.js';

/** Correlativos por negocio (número de cita…). */
@Schema({ collection: 'counters' })
export class Counter {
  organizationId: Types.ObjectId;

  @Prop({ required: true })
  key: string;

  @Prop({ required: true })
  value: number;
}

export const CounterSchema = SchemaFactory.createForClass(Counter);
CounterSchema.plugin(tenantPlugin);
CounterSchema.index({ organizationId: 1, key: 1 }, { unique: true });
