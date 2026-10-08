/**
 * Inicializa un MongoDB local como replica set de un nodo (necesario para
 * transacciones). Antes, agrega en mongod.cfg:
 *
 *   replication:
 *     replSetName: rs0
 *
 * y reinicia el servicio. Uso: pnpm db:init-rs [host:puerto]
 */
import mongoose from 'mongoose';

const host = process.argv[2] ?? '127.0.0.1:27017';
const conn = await mongoose
  .createConnection(`mongodb://${host}/admin?directConnection=true`, { serverSelectionTimeoutMS: 5000 })
  .asPromise();
const admin = conn.db.admin();

try {
  const status = await admin.command({ replSetGetStatus: 1 });
  console.log(`✔ Ya es un replica set: "${status.set}". Usa en .env:`);
  console.log(`  MONGODB_URI=mongodb://${host}/ubook?replicaSet=${status.set}`);
} catch (error) {
  if (error.codeName === 'NotYetInitialized') {
    const res = await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host }] } });
    console.log('✔ Replica set "rs0" inicializado.', res.ok === 1 ? '' : res);
    console.log(`  MONGODB_URI=mongodb://${host}/ubook?replicaSet=rs0`);
  } else if (error.codeName === 'NoReplicationEnabled') {
    console.error('✘ MongoDB no está iniciado con replicación.');
    console.error('  Agrega en mongod.cfg:\n\n  replication:\n    replSetName: rs0\n\n  y reinicia el servicio MongoDB.');
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await conn.close();
}
