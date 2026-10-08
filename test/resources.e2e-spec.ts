import request from 'supertest';
import { closeTestApp, createTestApp, registerBusiness, type TestContext } from './helpers.js';

let ctx: TestContext;
const http = () => request(ctx.app.getHttpServer());
const bearer = { type: 'bearer' as const };

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
const at = (date: string, hh: number) => new Date(Date.parse(`${date}T00:00:00Z`) + (hh * 60 + 300) * 60_000).toISOString();

async function setup(planCode?: string) {
  const owner = await registerBusiness(ctx.app, { planCode });
  const [branch] = (await http().get('/api/branches').auth(owner.token, bearer)).body;
  const service = (await http().post('/api/services').auth(owner.token, bearer).send({ name: 'Masaje', durationMinutes: 60, price: 9000 }).expect(201)).body;
  const pros: string[] = [];
  for (const name of ['Rosa', 'Ana']) {
    const pro = (
      await http().post('/api/professionals').auth(owner.token, bearer).send({ displayName: name, branchIds: [branch.id], services: [{ serviceId: service.id }] }).expect(201)
    ).body;
    await http()
      .put(`/api/professionals/${pro.id}/schedule`)
      .auth(owner.token, bearer)
      .send({ branchId: branch.id, days: [{ weekday: 1, intervals: [{ start: 540, end: 720 }] }] })
      .expect(200);
    pros.push(pro.id);
  }
  const client = (await http().post('/api/clients').auth(owner.token, bearer).send({ firstName: 'Lía' }).expect(201)).body;
  const date = nextMonday();
  const book = (pro: string, hh: number) =>
    http().post('/api/appointments').auth(owner.token, bearer).send({ branchId: branch.id, serviceId: service.id, professionalId: pro, clientId: client.id, startsAt: at(date, hh) });
  const free = async (pro: string) =>
    (await http().get(`/api/availability?branchId=${branch.id}&serviceId=${service.id}&professionalId=${pro}&date=${date}`).auth(owner.token, bearer).expect(200)).body.professionals[0].slots
      .filter((s: { available: boolean }) => s.available)
      .map((s: { start: string }) => s.start);
  return { owner, branchId: branch.id as string, serviceId: service.id as string, pros, date, book, free };
}

describe('Recursos', () => {
  it('un horario solo se ofrece si hay una cabina libre, aunque el profesional esté libre', async () => {
    const s = await setup();
    const cabina = (
      await http().post('/api/resources').auth(s.owner.token, bearer).send({ branchId: s.branchId, name: 'Cabina 1', kind: 'Sala privada', serviceIds: [s.serviceId] }).expect(201)
    ).body;

    const first = (await s.book(s.pros[0]!, 9).expect(201)).body;
    expect(first.resourceId).toBe(cabina.id);
    // Ana está libre a las 9, pero la única cabina no.
    expect(await s.free(s.pros[1]!)).not.toContain(at(s.date, 9));
    expect(await s.free(s.pros[1]!)).toContain(at(s.date, 10));
    expect((await s.book(s.pros[1]!, 9).expect(409)).body.code).toBe('SLOT_TAKEN');

    // Con una segunda cabina, Ana ya puede a las 9.
    const second = (await http().post('/api/resources').auth(s.owner.token, bearer).send({ branchId: s.branchId, name: 'Cabina 2', serviceIds: [s.serviceId] }).expect(201)).body;
    expect((await s.book(s.pros[1]!, 9).expect(201)).body.resourceId).toBe(second.id);

    const list = (await http().get(`/api/resources?branchId=${s.branchId}`).auth(s.owner.token, bearer).expect(200)).body;
    expect(list).toHaveLength(2);
  });

  it('respeta la capacidad y dos reservas simultáneas del mismo recurso no lo sobrepasan', async () => {
    const s = await setup();
    await http().post('/api/resources').auth(s.owner.token, bearer).send({ branchId: s.branchId, name: 'Sala única', serviceIds: [s.serviceId], capacity: 1 }).expect(201);
    const results = await Promise.all([s.book(s.pros[0]!, 10), s.book(s.pros[1]!, 10)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('el plan Starter no incluye recursos', async () => {
    const s = await setup('starter');
    await http().get(`/api/resources?branchId=${s.branchId}`).auth(s.owner.token, bearer).expect(403);
  });
});
