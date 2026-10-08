/**
 * Envía un correo de prueba con la configuración de Resend del .env.
 * Uso: pnpm mail:test tu-correo@ejemplo.com
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const apiKey = process.env.RESEND_API_KEY ?? env.RESEND_API_KEY;
const from = process.env.MAIL_FROM ?? env.MAIL_FROM ?? 'uBook <onboarding@resend.dev>';
const to = process.argv[2];

if (!apiKey) throw new Error('Falta RESEND_API_KEY en uBook-api/.env');
if (!to) throw new Error('Indica el destinatario: pnpm mail:test tu-correo@ejemplo.com');

const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from,
    to: [to],
    subject: 'Prueba de correo · uBook',
    html: '<p>Si lees esto, los correos de <b>uBook</b> ya salen por Resend. 🎉</p>',
    text: 'Si lees esto, los correos de uBook ya salen por Resend.',
  }),
});
const body = await res.text();
if (res.ok) console.log(`✔ Enviado a ${to} desde "${from}" (${body})`);
else {
  console.error(`✖ Resend respondió ${res.status}: ${body}`);
  process.exitCode = 1;
}
