/**
 * Activa las notificaciones por WhatsApp en todos los planes existentes.
 * Los planes nuevos ya la traen (plans.seed.ts); este script corrige las bases
 * creadas antes, cuando solo Business la incluía. Idempotente.
 * Uso: pnpm db:whatsapp-all-plans   (lee MONGODB_URI de .env)
 */
import { readFileSync } from 'node:fs';
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI ?? readFileSync('.env', 'utf8').match(/^MONGODB_URI=(.*)$/m)?.[1]?.trim();
if (!uri) throw new Error('Falta MONGODB_URI');

const conn = await mongoose.createConnection(uri).asPromise();
const res = await conn.db.collection('plans').updateMany({ 'features.whatsapp': { $ne: true } }, { $set: { 'features.whatsapp': true } });
console.log(`✔ WhatsApp activado en ${res.modifiedCount} planes`);
await conn.close();
