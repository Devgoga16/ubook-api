/**
 * 2026-10-06: el celular del cliente deja de ser único (se avisa al repetirlo)
 * y el DNI pasa a ser único por negocio.
 * - Quita el índice único de celular y crea uno normal.
 * - Normaliza los DNI guardados ("4567 8901" → "45678901") y borra los vacíos.
 * - Crea el índice único de DNI. Si hay DNI repetidos, los lista y no lo crea.
 * Idempotente. Uso: pnpm db:client-uniques   (lee MONGODB_URI de .env)
 */
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI ?? readFileSync('.env', 'utf8').match(/^MONGODB_URI=(.*)$/m)?.[1]?.trim();
if (!uri) throw new Error('Falta MONGODB_URI');

const conn = await mongoose.createConnection(uri).asPromise();
const clients = conn.db.collection('clients');

const indexes = await clients.indexes().catch(() => []);
for (const ix of indexes) {
  if (ix.unique && JSON.stringify(ix.key) === JSON.stringify({ organizationId: 1, phone: 1 })) {
    await clients.dropIndex(ix.name);
    console.log(`✔ Índice único de celular eliminado (${ix.name})`);
  }
}
await clients.createIndex({ organizationId: 1, phone: 1 });

let normalized = 0;
for await (const c of clients.find({ documentId: { $exists: true } }, { projection: { documentId: 1 } })) {
  const value = typeof c.documentId === 'string' ? c.documentId.replace(/[\s.-]/g, '').toUpperCase() : '';
  if (value === c.documentId) continue;
  await clients.updateOne({ _id: c._id }, value ? { $set: { documentId: value } } : { $unset: { documentId: '' } });
  normalized += 1;
}
console.log(`✔ DNI normalizados: ${normalized}`);

const dups = await clients
  .aggregate([
    { $match: { documentId: { $type: 'string' } } },
    { $group: { _id: { org: '$organizationId', doc: '$documentId' }, ids: { $push: '$_id' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ])
  .toArray();
if (dups.length) {
  console.log('✖ Hay DNI repetidos; corrígelos y vuelve a correr el script:');
  for (const d of dups) console.log(`  ${d._id.doc}: clientes ${d.ids.join(', ')}`);
  process.exitCode = 1;
} else {
  await clients.createIndex(
    { organizationId: 1, documentId: 1 },
    { unique: true, partialFilterExpression: { documentId: { $type: 'string' } } },
  );
  console.log('✔ Índice único de DNI listo');
}
await conn.close();
