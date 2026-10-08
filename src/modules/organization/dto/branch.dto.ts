import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, IsTimeZone, IsUrl, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class CreateBranchDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;

  /** Vacío = sin enlace. */
  @IsOptional()
  @ValidateIf((o: { mapsUrl?: string }) => !!o.mapsUrl)
  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'Pega el enlace completo de Google Maps (https://…)' })
  @MaxLength(500)
  mapsUrl?: string;
}

export class UpdateBranchDto extends PartialType(CreateBranchDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
