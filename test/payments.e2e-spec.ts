import request from 'supertest';
import { closeTestApp, createTestApp, registerBusiness, sessionAsMember, type TestContext } from './helpers.js';

let ctx: TestContext;
const http = () => request(ctx.app.getHttpServer());
const bearer = { type: 'bearer' as const };
const h = (hh: number, mm = 0) => hh * 60 + mm;

beforeAll(async () => {
  ctx = await createTestApp();
}, 180_000);

afterAll(async () => {
  await closeTestApp(ctx);
});

function nextMonday(): string {
  const d = new Date(Date.now() - 5 * 3_600_000 + 7 * 86_400_000);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const at = (date: string, hh: number, mm = 0) => new Date(Date.parse(`${date}T00:00:00Z`) + (h(hh, mm) + 300) * 60_000).toISOString();
const todayLima = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());

async function setup() {
  const owner = await registerBusiness(ctx.app);
  const orgId = owner.body.context.organizationId as string;
  const [branch] = (await http().get('/api/branches').auth(owner.token, bearer)).body;
  const service = (await http().post('/api/services').auth(owner.token, bearer).send({ name: 'Corte', durationMinutes: 30, price: 5000 }).expect(201)).body;
  const pro = (
    await http()
      .post('/api/professionals')
      .auth(owner.token, bearer)
      .send({ displayName: 'Luis', branchIds: [branch.id], services: [{ serviceId: service.id }], commissionPercent: 40 })
      .expect(201)
  ).body;
  await http()
    .put(`/api/professionals/${pro.id}/schedule`)
    .auth(owner.token, bearer)
    .send({ branchId: branch.id, days: [{ weekday: 1, intervals: [{ start: h(9), end: h(18) }] }] })
    .expect(200);
  const client = (await http().post('/api/clients').auth(owner.token, bearer).send({ firstName: 'Mateo', lastName: 'Huamán' }).expect(201)).body;
  const date = nextMonday();
  const book = async (hh: number) =>
    (
      await http()
        .post('/api/appointments')
        .auth(owner.token, bearer)
        .send({ branchId: branch.id, serviceId: service.id, professionalId: pro.id, clientId: client.id, startsAt: at(date, hh) })
        .expect(201)
    ).body.id as string;
  return { owner, orgId, branchId: branch.id as string, proId: pro.id as string, book };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const pay = (s: Setup, apptId: string, body: Record<string, unknown>, token = s.owner.token) =>
  http().post(`/api/appointments/${apptId}/payments`).auth(token, bearer).send(body);

describe('Cobros', () => {
  it('cobra con dos métodos, descuento y propina; calcula comisión y completa la cita', async () => {
    const s = await setup();
    const appt = await s.book(9);
    // Precio 50.00, descuento 5.00 → 45.00; paga 30 efectivo + 20 Yape = 50 (5 de propina).
    const res = await pay(s, appt, {
      methods: [
        { method: 'cash', amount: 3000 },
        { method: 'yape', amount: 2000, reference: '123456' },
      ],
      discount: 500,
      tip: 500,
      complete: true,
    }).expect(201);
    expect(res.body).toMatchObject({ price: 5000, discount: 500, paid: 4500, tips: 500, balance: 0, status: 'paid' });
    expect(res.body.payments[0]).toMatchObject({ number: 1, amount: 4500, tip: 500, total: 5000, commissionAmount: 1800, clientName: 'Mateo Huamán' });

    const a = (await http().get(`/api/appointments/${appt}`).auth(s.owner.token, bearer).expect(200)).body;
    expect(a.status).toBe('completed');

    // Ya está pagada: cualquier monto extra solo puede ser propina.
    expect((await pay(s, appt, { methods: [{ method: 'cash', amount: 100 }] }).expect(400)).body.code).toBe('OVERPAYMENT');
    await pay(s, appt, { methods: [{ method: 'cash', amount: 300 }], tip: 300 }).expect(201);
  });

  it('acepta adelantos y lleva el saldo; anular devuelve el saldo y solo lo hace el dueño', async () => {
    const s = await setup();
    const appt = await s.book(10);
    const first = await pay(s, appt, { methods: [{ method: 'transfer', amount: 2000 }], note: 'Adelanto' }).expect(201);
    expect(first.body).toMatchObject({ paid: 2000, balance: 3000, status: 'partial' });
    const second = await pay(s, appt, { methods: [{ method: 'card', amount: 3000 }] }).expect(201);
    expect(second.body.status).toBe('paid');

    const reception = await sessionAsMember(ctx.app, s.orgId, 'receptionist');
    const paymentId = second.body.payments[1].id as string;
    await http().post(`/api/payments/${paymentId}/void`).auth(reception.token, bearer).send({ reason: 'Error' }).expect(403);
    const voided = await http().post(`/api/payments/${paymentId}/void`).auth(s.owner.token, bearer).send({ reason: 'Se cobró dos veces' }).expect(201);
    expect(voided.body).toMatchObject({ status: 'voided', voidReason: 'Se cobró dos veces' });
    const after = (await http().get(`/api/appointments/${appt}/payments`).auth(s.owner.token, bearer).expect(200)).body;
    expect(after).toMatchObject({ paid: 2000, balance: 3000, status: 'partial' });

    // Recepción sí registra cobros.
    await pay(s, appt, { methods: [{ method: 'plin', amount: 3000 }] }, reception.token).expect(201);
  });

  it('no cobra citas canceladas', async () => {
    const s = await setup();
    const appt = await s.book(11);
    await http().post(`/api/appointments/${appt}/status`).auth(s.owner.token, bearer).send({ status: 'cancelled' }).expect(201);
    expect((await pay(s, appt, { methods: [{ method: 'cash', amount: 5000 }] }).expect(400)).body.code).toBe('APPOINTMENT_CANCELLED');
  });

  it('caja del día: totales por método, movimientos, cierre con diferencia y bloqueo hasta reabrir', async () => {
    const s = await setup();
    const today = todayLima();
    await pay(s, await s.book(9), { methods: [{ method: 'cash', amount: 5000 }] }).expect(201);
    await pay(s, await s.book(10), { methods: [{ method: 'yape', amount: 5500 }], tip: 500 }).expect(201);
    await http().post('/api/cash/movements').auth(s.owner.token, bearer).send({ branchId: s.branchId, type: 'out', amount: 1200, concept: 'Compra de toallas' }).expect(201);

    const day = (await http().get(`/api/cash/day?branchId=${s.branchId}&date=${today}`).auth(s.owner.token, bearer).expect(200)).body;
    expect(day.totals).toMatchObject({ count: 2, sales: 10000, tips: 500, collected: 10500, byMethod: { cash: 5000, yape: 5500 } });
    expect(day).toMatchObject({ cashOut: 1200, cashFromDay: 3800, close: null });

    // Fondo 100.00 + 38.00 del día = 138.00 esperado; contó 135.00 → faltan 3.00.
    const closed = await http()
      .post('/api/cash/close')
      .auth(s.owner.token, bearer)
      .send({ branchId: s.branchId, date: today, openingCash: 10000, countedCash: 13500, notes: 'Faltan 3 soles' })
      .expect(201);
    expect(closed.body.close).toMatchObject({ expectedCash: 13800, countedCash: 13500, difference: -300 });

    const blocked = await pay(s, await s.book(11), { methods: [{ method: 'cash', amount: 5000 }] }).expect(409);
    expect(blocked.body.code).toBe('CASH_CLOSED');
    await http().post('/api/cash/close').auth(s.owner.token, bearer).send({ branchId: s.branchId, date: today, openingCash: 0, countedCash: 0 }).expect(409);

    await http().post('/api/cash/reopen').auth(s.owner.token, bearer).send({ branchId: s.branchId, date: today }).expect(201);
    await pay(s, await s.book(12), { methods: [{ method: 'cash', amount: 5000 }] }).expect(201);
  });

  it('comisiones por profesional y el profesional solo ve sus cobros', async () => {
    const s = await setup();
    const today = todayLima();
    await pay(s, await s.book(9), { methods: [{ method: 'cash', amount: 6000 }], tip: 1000 }).expect(201);
    const rows = (await http().get(`/api/payments/commissions?from=${today}&to=${today}`).auth(s.owner.token, bearer).expect(200)).body;
    expect(rows).toEqual([expect.objectContaining({ displayName: 'Luis', appointments: 1, sales: 5000, commission: 2000, tips: 1000, toPay: 3000 })]);

    const member = await sessionAsMember(ctx.app, s.orgId, 'professional');
    const list = (await http().get(`/api/payments?from=${today}&to=${today}`).auth(member.token, bearer).expect(200)).body;
    expect(list.items).toHaveLength(0); // no es Luis
    await http().get(`/api/cash/day?branchId=${s.branchId}&date=${today}`).auth(member.token, bearer).expect(403);
  });
});
