import { Type } from 'class-transformer';
import { IsDate, IsIn, IsMongoId, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { APPOINTMENT_STATUSES, type AppointmentStatus } from '../schemas/appointment.schema.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class AvailabilityQuery {
  @IsMongoId()
  branchId: string;

  @IsMongoId()
  serviceId: string;

  /** Sin profesional = todos los que realizan el servicio en esa sede. */
  @IsOptional()
  @IsMongoId()
  professionalId?: string;

  @Matches(DATE)
  date: string;

  /** Para reprogramar: ignora esta cita al calcular lo ocupado. */
  @IsOptional()
  @IsMongoId()
  excludeAppointmentId?: string;
}

export class AvailabilityDaysQuery {
  @IsMongoId()
  branchId: string;

  @IsMongoId()
  serviceId: string;

  @IsOptional()
  @IsMongoId()
  professionalId?: string;

  /** Primer día del rango (máximo 42 días). */
  @Matches(DATE)
  from: string;

  @Matches(DATE)
  to: string;
}

export class CreateAppointmentDto {
  @IsMongoId()
  branchId: string;

  @IsMongoId()
  serviceId: string;

  @IsMongoId()
  professionalId: string;

  @IsMongoId()
  clientId: string;

  @Type(() => Date)
  @IsDate()
  startsAt: Date;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class ListAppointmentsQuery {
  @IsMongoId()
  branchId: string;

  @Type(() => Date)
  @IsDate()
  from: Date;

  @Type(() => Date)
  @IsDate()
  to: Date;

  @IsOptional()
  @IsMongoId()
  professionalId?: string;
}

export class ChangeStatusDto {
  @IsIn(APPOINTMENT_STATUSES)
  status: AppointmentStatus;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  /** Al cancelar: quién lo pidió (define el correo que recibe el cliente). */
  @IsOptional()
  @IsIn(['client', 'business'])
  by?: 'client' | 'business';
}

/** Cambiar horario y, opcionalmente, profesional y/o servicio. */
export class RescheduleDto {
  @Type(() => Date)
  @IsDate()
  startsAt: Date;

  @IsOptional()
  @IsMongoId()
  professionalId?: string;

  @IsOptional()
  @IsMongoId()
  serviceId?: string;
}

export class UpdateAppointmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsMongoId()
  clientId?: string;
}
