import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import { IsDate, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AuditService } from '../../core/audit/audit.service.js';
import { RequireFeature, RequirePermission } from '../../core/auth/decorators.js';
import { PERMISSIONS } from '../../core/authorization/permissions.catalog.js';
import { MAX_IMAGE_BYTES } from '../../core/storage/storage.service.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { BranchesService } from './branches.service.js';
import { CreateBranchDto, UpdateBranchDto } from './dto/branch.dto.js';
import { UpdateOrganizationDto } from './dto/organization.dto.js';
import { CreateRoleDto, UpdateMemberDto, UpdateRoleDto } from './dto/role.dto.js';
import { MembersService } from './members.service.js';
import { OrganizationsService } from './organizations.service.js';
import { RolesService } from './roles.service.js';
import { ParseObjectIdPipe } from '../../core/common/parse-object-id.pipe.js';

class AuditQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  before?: Date;
}

/** Negocio activo del usuario (contexto staff). */
@Controller()
export class OrganizationController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly branches: BranchesService,
    private readonly roles: RolesService,
    private readonly members: MembersService,
    private readonly audit: AuditService,
  ) {}

  @Get('organization')
  get() {
    return this.organizations.currentView();
  }

  @RequirePermission('organization.manage')
  @Patch('organization')
  async update(@Body() dto: UpdateOrganizationDto) {
    return this.organizations.view(await this.organizations.updateCurrent(dto));
  }

  /** Logo del negocio (JPG, PNG o WebP). Se ve en la app y en la página de reservas. */
  @RequirePermission('organization.manage')
  @RequireFeature('branding')
  @Post('organization/logo')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  uploadLogo(@UploadedFile() file?: { buffer: Buffer }) {
    return this.organizations.setLogo(file?.buffer ?? Buffer.alloc(0));
  }

  @RequirePermission('organization.manage')
  @Delete('organization/logo')
  removeLogo() {
    return this.organizations.removeLogo();
  }

  @Get('branches')
  listBranches() {
    return this.branches.list();
  }

  @RequirePermission('branch.manage')
  @Post('branches')
  createBranch(@Body() dto: CreateBranchDto) {
    return this.branches.create(dto);
  }

  @RequirePermission('branch.manage')
  @Patch('branches/:id')
  updateBranch(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateBranchDto) {
    return this.branches.update(id, dto);
  }

  /** Catálogo de permisos para el editor de roles. */
  @RequirePermission('role.read')
  @Get('permissions')
  permissions() {
    return Object.entries(PERMISSIONS).map(([key, def]) => ({ key, ...def }));
  }

  @RequirePermission('role.read')
  @Get('roles')
  listRoles() {
    return this.roles.list();
  }

  @RequirePermission('role.manage')
  @Post('roles')
  createRole(@Body() dto: CreateRoleDto) {
    return this.roles.create(dto);
  }

  @RequirePermission('role.manage')
  @Patch('roles/:id')
  updateRole(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateRoleDto) {
    return this.roles.update(id, dto);
  }

  @RequirePermission('role.manage')
  @Delete('roles/:id')
  @HttpCode(204)
  removeRole(@Param('id', ParseObjectIdPipe) id: string) {
    return this.roles.remove(id);
  }

  @RequirePermission('member.read')
  @Get('members')
  listMembers() {
    return this.members.list();
  }

  @RequirePermission('member.manage')
  @Patch('members/:id')
  updateMember(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateMemberDto) {
    return this.members.update(id, dto);
  }

  @RequirePermission('audit.read')
  @RequireFeature('audit_log')
  @Get('audit-logs')
  auditLogs(@Query() query: AuditQueryDto) {
    return this.audit.list(TenantContext.requireOrganizationId(), query.limit, query.before);
  }
}
