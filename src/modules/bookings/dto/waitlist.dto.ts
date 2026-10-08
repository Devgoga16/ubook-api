import { Transform, Type } from 'class-transformer';
import { Equals, IsBoolean, IsDate, IsIn, IsMongoId, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { TIMES_OF_DAY, type TimeOfDay } from '../schemas/waitlist.schema.js';
import { PublicClientDto } from './public-booking.dto.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class WaitlistBase {
  @IsMongoId()
  branchId: string;

  @IsMongoId()
  serviceId: string;

  @IsOptional()
  @IsMongoId()
  professionalId?: string;

  @Matches(DATE)
  dateFrom: string;

  @Matches(DATE)
  dateTo: string;

  @IsOptional()
  @IsIn(TIMES_OF_DAY)
  timeOfDay?: TimeOfDay;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class CreateWaitlistDto extends WaitlistBase {
  @IsMongoId()
  clientId: string;
}

export class PublicWaitlistDto extends WaitlistBase {
  @ValidateNested()
  @Type(() => PublicClientDto)
  client: PublicClientDto;

  @Equals(true, { message: 'Debes aceptar el uso de tus datos' })
  acceptsTerms: boolean;

  @IsOptional()
  @IsBoolean()
  marketingConsent?: boolean;
}

export class ListWaitlistQuery {
  @IsMongoId()
  branchId: string;

  @IsOptional()
  @IsIn(['waiting', 'booked', 'removed'])
  status?: 'waiting' | 'booked' | 'removed';
}

export class UpdateWaitlistDto {
  @IsOptional()
  @IsIn(['waiting', 'removed'])
  status?: 'waiting' | 'removed';

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class BookFromWaitlistDto {
  @IsMongoId()
  professionalId: string;

  @Type(() => Date)
  @IsDate()
  startsAt: Date;
}
