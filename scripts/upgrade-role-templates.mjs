/**
 * Actualiza los roles creados con versiones anteriores de las plantillas.
 * Solo AGREGA permisos que la plantilla incorporó después; nunca quita ni
 * cambia el alcance de los que el negocio ya tiene. Idempotente.
 * Uso: pnpm db:upgrade-roles   (lee MONGODB_URI de .env)
 */
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI ?? readFileSync('.env', 'utf8').match(/^MONGODB_URI=(.*)$/m)?.[1]?.trim();
if (!uri) throw new Error('Falta MONGODB_URI');

/** Permisos agregados a las plantillas después de su primera versión. */
const ADDED = {
  professional: [{ key: 'booking.create', scope: 'own' }], // 2026-10-06: agendar en su propia agenda
};

const conn = await mongoose.createConnection(uri).asPromise();
const roles = conn.db.collection('roles');
for (const [templateKey, perms] of Object.entries(ADDED)) {
  for (const perm of perms) {
    const res = await roles.updateMany(
      { templateKey, 'permissions.key': { $ne: perm.key } },
      { $push: { permissions: perm } },
    );
    console.log(`✔ ${templateKey} + ${perm.key} (${perm.scope}): ${res.modifiedCount} roles actualizados`);
  }
}
await conn.close();
