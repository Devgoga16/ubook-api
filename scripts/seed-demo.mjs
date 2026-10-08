/**
 * Carga un negocio de ejemplo en una API de PRUEBAS (por defecto la de
 * `ubook-api-test`, puerto 3100). Nunca apuntes esto a tu API real.
 * Uso: node scripts/seed-demo.mjs [http://localhost:3100]
 */
const B = `${process.argv[2] ?? 'http://localhost:3100'}/api`;
const call = (p, b, t, m = 'POST') =>
  fetch(B + p, {
    method: m,
    headers: { 'content-type': 'application/json', ...(t && { authorization: `Bearer ${t}` }) },
    body: b === undefined ? undefined : JSON.stringify(b),
  }).then(async (r) => {
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${m} ${p} → ${r.status} ${JSON.stringify(j)}`);
    return j;
  });

const { accessToken: t } = await call('/auth/register', {
  firstName: 'Demo',
  lastName: 'Pruebas',
  email: 'demo@pruebas.test',
  password: 'Prueba12345x',
  organization: { name: 'Barbería Demo', businessType: 'barbershop' },
});
const [main] = await fetch(`${B}/branches`, { headers: { authorization: `Bearer ${t}` } }).then((r) => r.json());
await call(`/branches/${main.id}`, { name: 'Sede Miraflores', address: 'Av. Larco 812' }, t, 'PATCH');
const si = await call('/branches', { name: 'Sede San Isidro', address: 'Calle Las Begonias 455' }, t);
const cortes = await call('/service-categories', { name: 'Cortes' }, t);
const barba = await call('/service-categories', { name: 'Barba' }, t);
const s = [];
for (const [name, durationMinutes, price, categoryId, color] of [
  ['Corte clásico', 30, 3500, cortes.id, '#243352'],
  ['Corte + barba', 45, 5000, cortes.id, '#8F5400'],
  ['Afeitado con toalla', 30, 3000, barba.id, '#2F5D8A'],
]) s.push(await call('/services', { name, durationMinutes, price, categoryId, color, bufferAfterMinutes: 10 }, t));
const h = (x) => x * 60;
const luis = await call('/professionals', {
  displayName: 'Luis Paredes', title: 'Barbero senior', branchIds: [main.id, si.id],
  services: [{ serviceId: s[0].id }, { serviceId: s[1].id, price: 5500 }], commissionPercent: 45, color: '#243352',
}, t);
await call(`/professionals/${luis.id}/schedule`, {
  branchId: main.id,
  days: [1, 2, 3].map((weekday) => ({ weekday, intervals: [{ start: h(9), end: h(13) }, { start: h(14), end: h(19) }] })),
}, t, 'PUT');
await call(`/professionals/${luis.id}/schedule`, {
  branchId: si.id,
  days: [
    ...[4, 5].map((weekday) => ({ weekday, intervals: [{ start: h(11), end: h(15) }, { start: h(16), end: h(21) }] })),
    { weekday: 6, intervals: [{ start: h(9), end: h(15) }] },
  ],
}, t, 'PUT');
await call(`/professionals/${luis.id}/time-off`, { type: 'vacation', title: 'Vacaciones', startsAt: '2026-10-19T05:00:00Z', endsAt: '2026-10-27T05:00:00Z' }, t);
const andrea = await call('/professionals', {
  displayName: 'Andrea Quispe', title: 'Estilista', branchIds: [main.id], color: '#1F6F78',
  services: [{ serviceId: s[0].id }, { serviceId: s[2].id }],
}, t);
await call(`/professionals/${andrea.id}/schedule`, {
  branchId: main.id,
  days: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, intervals: [{ start: h(10), end: h(13) }, { start: h(14), end: h(19) }] })),
}, t, 'PUT');

const clients = [];
for (const [firstName, lastName, phone] of [
  ['Mateo', 'Huamán', '987654321'], ['Valeria', 'Ríos', '956112450'], ['Sebastián', 'Castro', '912330871'], ['Lucía', 'Mendoza', '944208115'],
]) clients.push(await call('/clients', { firstName, lastName, phone }, t));

// Citas de hoy (hora de Lima) para ver la agenda con contenido.
const today = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
const at = (hh, mm = 0) => new Date(Date.parse(`${today}T00:00:00Z`) + (hh * 60 + mm + 300) * 60_000).toISOString();
const book = (professionalId, serviceId, clientId, startsAt) =>
  call('/appointments', { branchId: main.id, serviceId, professionalId, clientId, startsAt }, t).catch((e) => console.warn('  (omitida)', e.message.slice(0, 80)));
const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
if (weekday >= 1 && weekday <= 3) {
  const a = await book(luis.id, s[0].id, clients[0].id, at(9));
  await book(luis.id, s[1].id, clients[1].id, at(10));
  await book(luis.id, s[1].id, clients[2].id, at(15));
  if (a) await call(`/appointments/${a.id}/status`, { status: 'completed' }, t).catch(() => {});
}
if (weekday >= 1 && weekday <= 6) {
  await book(andrea.id, s[2].id, clients[3].id, at(11));
  await book(andrea.id, s[0].id, clients[1].id, at(16, 30));
}
console.log('Demo lista: demo@pruebas.test / Prueba12345x');
