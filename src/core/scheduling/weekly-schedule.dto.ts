import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, Max, Min, ValidateNested } from 'class-validator';

export class TimeRangeDto {
  @IsInt()
  @Min(0)
  @Max(1440)
  start: number;

  @IsInt()
  @Min(0)
  @Max(1440)
  end: number;
}

export class DayScheduleDto {
  @IsInt()
  @Min(1)
  @Max(7)
  weekday: number;

  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => TimeRangeDto)
  intervals: TimeRangeDto[];
}
