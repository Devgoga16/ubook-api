import request from 'supertest';
import { closeTestApp, createTestApp, registerBusiness, sessionAsMember, type TestContext } from './helpers.js';

let ctx: TestContext;
const http = () => request(ctx.app.getHttpServer());
const bearer = { type: 'bearer' as const };

beforeAll(async () => {
  ctx = await createTestApp();
}, 180_000);

afterAll(async () => {
  await closeTestApp(ctx);
});

const todayLima = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
const todayAt = (hh: number) => new Date(Date.parse(`${todayLima()}T00:00:00Z`) + (hh * 60 + 300) * 60_000).toISOString();
const weekdayToday = () => {
  const d = new Date(`${todayLima()}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};

async function setup(planCode?: string) {
  const owner = await registerBusiness(ctx.app, { planCode });
  const [branch] = (await http().get('/api/branches').auth(owner.token, bearer)).body;
  const service = (await http().post('/api/services').auth(owner.token, bearer).send({ name: 'Corte', durationMinutes: 60, price: 4000 }).expect(201)).body;
  const pro = (
    await http().post('/api/professionals').auth(owner.token, bearer).send({ displayName: 'Luis', branchIds: [branch.id], services: [{ serviceId: service.id }], commissionPercent: 50 }).expect(201)
  ).body;
  // 9:00–13:00 todos los días: 240 minutos de capacidad por día.
  await http()
    .put(`/api/professionals/${pro.id}/schedule`)
    .auth(owner.token, bearer)
    .send({ branchId: branch.id, days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, intervals: [{ start: 540, end: 780 }] })) })
    .expect(200);
  const client = (await http().post('/api/clients').auth(owner.token, bearer).send({ firstName: 'Ana', lastName: 'Ríos' }).expect(201)).body;
  const book = async (hh: number) =>
    (
      await http()
        .post('/api/appointments')
        .auth(owner.token, bearer)
        .send({ branchId: branch.id, serviceId: service.id, professionalId: pro.id, clientId: client.id, startsAt: todayAt(hh) })
        .expect(201)
    ).body.id as string;
  const status = (id: string, s: string) => http().post(`/api/appointments/${id}/status`).auth(owner.token, bearer).send({ status: s }).expect(201);
  return { owner, branchId: branch.id as string, book, status };
}

describe('Reportes', () => {
  it('ventas, ocupación, faltas, servicios, profesionales y mapa de calor del periodo', async () => {
    const s = await setup();
    const done = await s.book(9);
    const missed = await s.book(11);
    await s.status(done, 'checked_in');
    await s.status(done, 'completed');
    await s.status(missed, 'no_show');
    await http().post(`/api/appointments/${done}/payments`).auth(s.owner.token, bearer).send({ methods: [{ method: 'yape', amount: 4500 }], tip: 500 }).expect(201);

    const today = todayLima();
    const r = (await http().get(`/api/reports?from=${today}&to=${today}`).auth(s.owner.token, bearer).expect(200)).body;
    expect(r.advanced).toBe(true);
    expect(r.kpis).toMatchObject({
      sales: { value: 4000, previous: 0 },
      collected: { value: 4500 },
      attended: { value: 1 },
      averageTicket: { value: 4000 },
      occupancy: { value: 25 }, // 60 de 240 minutos (la falta no ocupa)
      noShowRate: { value: 50 },
      newClients: { value: 1 },
    });
    expect(r.byService).toEqual([{ serviceName: 'Corte', appointments: 1, sales: 4000 }]);
    expect(r.byProfessional).toEqual([expect.objectContaining({ displayName: 'Luis', attended: 1, sales: 4000, occupancy: 25, noShows: 1, commission: 2000, tips: 500 })]);
    expect(r.heatmap.hours).toEqual([9, 10, 11, 12]);
    expect(r.heatmap.cells).toContainEqual({ weekday: weekdayToday(), hour: 9, percent: 100 });
    expect(r.heatmap.cells).toContainEqual({ weekday: weekdayToday(), hour: 11, percent: 0 });
    expect(r.noShowTrend).toHaveLength(12);
    expect(r.noShowTrend.at(-1)).toMatchObject({ total: 2, noShows: 1, rate: 50 });
    expect(r.topClients[0]).toMatchObject({ name: 'Ana Ríos', visits: 1, sales: 4000 });

    const rows = (await http().get(`/api/reports/export?from=${today}&to=${today}`).auth(s.owner.token, bearer).expect(200)).body;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ time: '09:00', client: 'Ana Ríos', service: 'Corte', status: 'completed', paid: 4000, tip: 500, methods: 'yape' });
  });

  it('el plan Starter tiene reportes básicos y sin exportación; recepción no ve reportes', async () => {
    const s = await setup('starter');
    const today = todayLima();
    const r = (await http().get(`/api/reports?from=${today}&to=${today}`).auth(s.owner.token, bearer).expect(200)).body;
    expect(r.advanced).toBe(false);
    expect(r.byProfessional).toBeUndefined();
    expect(r.heatmap).toBeUndefined();
    await http().get(`/api/reports/export?from=${today}&to=${today}`).auth(s.owner.token, bearer).expect(403);

    const reception = await sessionAsMember(ctx.app, s.owner.body.context.organizationId as string, 'receptionist');
    await http().get(`/api/reports?from=${today}&to=${today}`).auth(reception.token, bearer).expect(403);
    await http().get('/api/reports?from=2026-01-01&to=2027-12-31').auth(s.owner.token, bearer).expect(400);
  });
});
