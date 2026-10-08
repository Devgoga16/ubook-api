import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsMongoId,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { FIELD_TYPES, type FieldType } from '../record-fields.js';

export class RecordFieldDto {
  @Matches(/^[a-z0-9_]{1,40}$/)
  key: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label: string;

  @IsIn(FIELD_TYPES)
  type: FieldType;

  @IsBoolean()
  required: boolean;

  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  options: string[];

  @IsOptional()
  @IsString()
  @MaxLength(160)
  helpText?: string;
}

export class CreateTemplateDto {
  /** Copiar una plantilla lista (general, beauty, psychology, dental). */
  @IsOptional()
  @IsString()
  preset?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => RecordFieldDto)
  fields?: RecordFieldDto[];
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => RecordFieldDto)
  fields?: RecordFieldDto[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateRecordDto {
  @IsMongoId()
  templateId: string;

  @IsObject()
  values: Record<string, unknown>;

  @IsOptional()
  @IsMongoId()
  appointmentId?: string;

  /** Firmar al guardar (queda cerrada). */
  @IsOptional()
  @IsBoolean()
  sign?: boolean;
}

export class UpdateRecordDto {
  @IsObject()
  values: Record<string, unknown>;
}

export class AddendumDto {
  @IsString()
  @MinLength(2)
  @MaxLength(5000)
  text: string;
}
