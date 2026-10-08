import { Prop, Schema } from '@nestjs/mongoose';

/** Ver weekly-schedule.ts: minutos desde la medianoche, día ISO 1–7. */
@Schema({ _id: false })
export class TimeRangeEntry {
  /** Minutos desde la medianoche, hora local de la sucursal. */
  @Prop({ required: true, min: 0, max: 1440 })
  start: number;

  @Prop({ required: true, min: 0, max: 1440 })
  end: number;
}

@Schema({ _id: false })
export class DayScheduleEntry {
  /** 1 = lunes … 7 = domingo. */
  @Prop({ required: true, min: 1, max: 7 })
  weekday: number;

  @Prop({ type: [TimeRangeEntry], default: [] })
  intervals: TimeRangeEntry[];
}
