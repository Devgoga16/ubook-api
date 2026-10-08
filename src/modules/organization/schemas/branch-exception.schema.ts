import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, type HydratedDocument, type Types } from 'mongoose';
import { tenantPlugin } from '../../../core/database/tenant.plugin.js';
import { TimeRangeEntry } from '../../../core/scheduling/weekly-schedule.schema.js';

export type BranchExceptionType = 'closed' | 'custom_hours';

/** Feriado o día especial de una sede: cerrado o con otro horario. */
@Schema({ timestamps: true, collection: 'branch_exceptions' })
export class BranchException {
  organizationId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Branch', required: true, index: true })
  branchId: Types.ObjectId;

  /** Fecha local de la sede, "YYYY-MM-DD". */
  @Prop({ required: true, match: /^\d{4}-\d{2}-\d{2}$/ })
  date: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: String, enum: ['closed', 'custom_hours'], required: true })
  type: BranchExceptionType;

  /** Solo para `custom_hours`. */
  @Prop({ type: [TimeRangeEntry], default: [] })
  intervals: TimeRangeEntry[];
}

export type BranchExceptionDocument = HydratedDocument<BranchException>;
export const BranchExceptionSchema = SchemaFactory.createForClass(BranchException);
BranchExceptionSchema.plugin(tenantPlugin);
BranchExceptionSchema.index({ organizationId: 1, branchId: 1, date: 1 }, { unique: true });
