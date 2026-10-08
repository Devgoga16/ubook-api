import { Schema, Types, type MongooseQueryMiddleware, type Query } from 'mongoose';
import { TenantContext } from '../tenancy/tenant-context.js';

const SCOPED_QUERY_OPS: MongooseQueryMiddleware[] = [
  'countDocuments',
  'deleteMany',
  'deleteOne',
  'distinct',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne',
];

export class CrossTenantWriteError extends Error {
  constructor() {
    super('Escritura bloqueada: el documento pertenece a otra organización.');
  }
}

/**
 * Aísla una colección por organización.
 *
 * - Agrega `organizationId` (obligatorio, indexado e inmutable).
 * - Toda consulta y agregación se filtra por la organización en contexto.
 * - Al guardar se asigna la organización en contexto y se rechaza otra distinta.
 * - Sin organización en contexto (y sin `runAsSystem`) la operación falla:
 *   se prefiere un error a filtrar datos de otro negocio.
 *
 * No cubre `bulkWrite` ni `estimatedDocumentCount`; no los uses en modelos de tenant.
 */
export function tenantPlugin(schema: Schema): void {
  schema.add({
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
      immutable: true,
    },
  });

  schema.pre(SCOPED_QUERY_OPS, function (this: Query<unknown, unknown>) {
    if (TenantContext.isBypassed()) return;
    this.where({ organizationId: TenantContext.requireOrganizationId() });
  });

  schema.pre('aggregate', function () {
    if (TenantContext.isBypassed()) return;
    const orgId = new Types.ObjectId(TenantContext.requireOrganizationId());
    this.pipeline().unshift({ $match: { organizationId: orgId } });
  });

  schema.pre('validate', function () {
    if (TenantContext.isBypassed()) return;
    const orgId = TenantContext.requireOrganizationId();
    const current = this.get('organizationId') as Types.ObjectId | undefined;
    if (!current) {
      this.set('organizationId', orgId);
    } else if (!current.equals(orgId)) {
      throw new CrossTenantWriteError();
    }
  });
}
