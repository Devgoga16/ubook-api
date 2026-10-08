/**
 * Repara datos de desarrollo creados antes de dos arreglos. Idempotente.
 * 1. Referencias guardadas como texto en vez de ObjectId.
 * 2. Campos borrados por ediciones parciales (p. ej. `isActive` de la sede
 *    renombrada en el registro).
 * Uso: pnpm db:fix-ids   (lee MONGODB_URI de .env)
 */
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';

const uri =
  process.env.MONGODB_URI ?? readFileSync('.env', 'utf8').match(/^MONGODB_URI=(.*)$/m)?.[1]?.trim();
if (!uri) throw new Error('Falta MONGODB_URI');

const FIELDS = {
  memberships: ['userId'],
  sessions: ['userId', 'familyId', 'organizationId', 'membershipId'],
  subscriptions: ['organizationId'],
  organizations: ['createdBy'],
  audit_logs: ['organizationId', 'actorUserId'],
  services: ['categoryId'],
};

const conn = await mongoose.createConnection(uri).asPromise();
for (const [collection, fields] of Object.entries(FIELDS)) {
  for (const field of fields) {
    const res = await conn.db
      .collection(collection)
      .updateMany({ [field]: { $type: 'string', $regex: /^[a-f0-9]{24}$/i } }, [
        { $set: { [field]: { $toObjectId: `$${field}` } } },
      ]);
    if (res.modifiedCount) console.log(`✔ ${collection}.${field}: ${res.modifiedCount} corregidos`);
  }
}
const DEFAULTS = {
  branches: { isActive: true },
  services: { isArchived: false, onlineBooking: true, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, sortOrder: 0 },
  organizations: { status: 'active', locale: 'es' },
  memberships: { status: 'active' },
  professionals: { isActive: true },
};
for (const [collection, defaults] of Object.entries(DEFAULTS)) {
  for (const [field, value] of Object.entries(defaults)) {
    const res = await conn.db
      .collection(collection)
      .updateMany({ [field]: { $exists: false } }, { $set: { [field]: value } });
    if (res.modifiedCount) console.log(`✔ ${collection}.${field}: ${res.modifiedCount} restaurados`);
  }
}

console.log('Listo.');
await conn.close();
