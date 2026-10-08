import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  PERMISSION_KEYS,
  SCOPES,
  type PermissionKey,
  type Scope,
} from '../../../core/authorization/permissions.catalog.js';

export class RolePermissionDto {
  @IsIn(PERMISSION_KEYS)
  key: PermissionKey;

  @IsIn(SCOPES)
  scope: Scope;
}

export class CreateRoleDto {
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RolePermissionDto)
  permissions: RolePermissionDto[];
}

export class UpdateRoleDto extends PartialType(CreateRoleDto) {}

export class UpdateMemberDto {
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsMongoId({ each: true })
  roleIds?: string[];

  /** Vacío = todas las sucursales. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsMongoId({ each: true })
  branchIds?: string[];

  @IsOptional()
  @IsIn(['active', 'suspended'])
  status?: 'active' | 'suspended';
}
