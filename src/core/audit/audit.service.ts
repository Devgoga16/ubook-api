import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { TenantContext } from '../tenancy/tenant-context.js';
import { AuditLog, type AuditLogDocument } from './audit-log.schema.js';

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  /** Por defecto se toman del contexto de la petición. */
  organizationId?: string;
  actorUserId?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@InjectModel(AuditLog.name) private readonly logs: Model<AuditLog>) {}

  async log(entry: AuditEntry, session?: ClientSession): Promise<void> {
    const doc = {
      ...entry,
      organizationId: entry.organizationId ?? TenantContext.getOrganizationId(),
      actorUserId: entry.actorUserId ?? TenantContext.getActor()?.userId,
    };
    try {
      await this.logs.create([doc], { session });
    } catch (error) {
      // Dentro de una transacción el error debe propagarse para abortarla.
      if (session) throw error;
      this.logger.error(`No se pudo registrar auditoría "${entry.action}"`, error as Error);
    }
  }

  list(organizationId: string, limit = 50, before?: Date): Promise<AuditLogDocument[]> {
    return this.logs
      .find({ organizationId, ...(before && { createdAt: { $lt: before } }) })
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 200))
      .exec();
  }
}
