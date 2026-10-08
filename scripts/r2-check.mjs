/**
 * Diagnóstico de Cloudflare R2 con las credenciales del .env (no imprime secretos).
 * Uso: node scripts/r2-check.mjs
 */
import { readFileSync } from 'node:fs';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^R2_[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const bucket = env.R2_BUCKET;
const key = `_diagnostico/${Date.now()}.txt`;

for (const host of [`${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, `${env.R2_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`]) {
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${host}`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
  console.log(`\nEndpoint ${host.includes('.eu.') ? 'UE (jurisdicción europea)' : 'por defecto'}:`);
  const step = async (name, cmd) => {
    try {
      await s3.send(cmd);
      console.log(`  ✓ ${name}`);
      return true;
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.Code ?? e.name} (${e.$metadata?.httpStatusCode ?? '-'})`);
      return false;
    }
  };
  await step(`ver bucket "${bucket}"`, new HeadBucketCommand({ Bucket: bucket }));
  if (await step('subir archivo de prueba', new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'ok', ContentType: 'text/plain' }))) {
    await step('leer archivo de prueba', new GetObjectCommand({ Bucket: bucket, Key: key }));
    await step('borrar archivo de prueba', new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}
