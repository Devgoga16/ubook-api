/**
 * Levanta la API en modo desarrollo con un MongoDB en memoria (replica set),
 * para trabajar sin instalar Mongo. Los datos se pierden al detenerla.
 * Para datos persistentes usa `pnpm start:dev` con MONGODB_URI (p. ej. Atlas).
 */
import { spawn } from 'node:child_process';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
const uri = mongo.getUri('ubook_dev');
console.log(`\n[dev-memory] MongoDB en memoria: ${uri}\n`);

// --once: sin modo watch (útil para levantar una segunda API de pruebas en otro PORT
// sin competir con la de desarrollo).
const watch = !process.argv.includes('--once');
const child = spawn(`pnpm exec nest start${watch ? ' --watch' : ''}`, {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, MONGODB_URI: uri },
});

const stop = async () => {
  child.kill();
  await mongo.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', async (code) => {
  await mongo.stop();
  process.exit(code ?? 0);
});
