import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, Types, type HydratedDocument } from 'mongoose';

/**
 * Registro inmutable de acciones relevantes. Colección global (no usa el
 * plugin de tenant) porque también registra acciones de plataforma;
 * las lecturas por negocio filtran `organizationId` explícitamente.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'audit_logs' })
export class AuditLog {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Organization', index: true })
  organizationId?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User' })
  actorUserId?: Types.ObjectId;

  /** Verbo en pasado: 'organization.created', 'role.updated', 'auth.login'... */
  @Prop({ required: true })
  action: string;

  @Prop()
  entityType?: string;

  @Prop()
  entityId?: string;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;

  createdAt: Date;
}

export type AuditLogDocument = HydratedDocument<AuditLog>;
export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
AuditLogSchema.index({ organizationId: 1, createdAt: -1 });
