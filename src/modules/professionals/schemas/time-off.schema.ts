import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, type HydratedDocument, type Types } from 'mongoose';
import { tenantPlugin } from '../../../core/database/tenant.plugin.js';

export const TIME_OFF_TYPES = ['vacation', 'training', 'medical', 'personal', 'other'] as const;
export type TimeOffType = (typeof TIME_OFF_TYPES)[number];
export type TimeOffStatus = 'pending' | 'approved' | 'rejected';

/** Ausencia de un profesional: vacaciones, capacitación, cita médica… */
@Schema({ timestamps: true, collection: 'time_off' })
export class TimeOff {
  organizationId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Professional', required: true, index: true })
  professionalId: Types.ObjectId;

  @Prop({ type: String, enum: TIME_OFF_TYPES, required: true })
  type: TimeOffType;

  @Prop({ trim: true })
  title?: string;

  /** Instantes UTC. Un día completo en Lima: 05:00Z → 05:00Z del día siguiente. */
  @Prop({ required: true })
  startsAt: Date;

  @Prop({ required: true })
  endsAt: Date;

  @Prop({ type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' })
  status: TimeOffStatus;

  @Prop({ trim: true })
  note?: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User' })
  requestedBy?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User' })
  decidedBy?: Types.ObjectId;

  @Prop()
  decidedAt?: Date;
}

export type TimeOffDocument = HydratedDocument<TimeOff>;
export const TimeOffSchema = SchemaFactory.createForClass(TimeOff);
TimeOffSchema.plugin(tenantPlugin);
TimeOffSchema.index({ organizationId: 1, professionalId: 1, startsAt: 1 });
