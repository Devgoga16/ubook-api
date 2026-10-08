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
/** Hora local de Lima de hoy → ISO UTC. */
const todayAt = (hh: number, mm = 0) => new Date(Date.parse(`${todayLima()}T00:00:00Z`) + ((hh * 60 + mm) + 300) * 60_000).toISOString();

describe('Dashboard', () => {
  it('resume citas, ocupación, ingresos y avisos del día según el alcance de cada persona', async () => {
    const owner = await registerBusiness(ctx.app);
    const orgId = owner.body.context.organizationId as string;
    const [branch] = (await http().get('/api/branches').auth(owner.token, bearer)).body;
    const service = (await http().post('/api/services').auth(owner.token, bearer).send({ name: 'Corte', durationMinutes: 60, price: 4000 }).expect(201)).body;
    const pro = (
      await http()
        .post('/api/professionals')
        .auth(owner.token, bearer)
        .send({ displayName: 'Luis', branchIds: [branch.id], services: [{ serviceId: service.id }] })
        .expect(201)
    ).body;
    // Trabaja todo el día, todos los días: 24 h de capacidad hoy.
    await http()
      .put(`/api/professionals/${pro.id}/schedule`)
      .auth(owner.token, bearer)
      .send({ branchId: branch.id, days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, intervals: [{ start: 0, end: 1440 }] })) })
      .expect(200);
    const client = (await http().post('/api/clients').auth(owner.token, bearer).send({ firstName: 'Ana', lastName: 'Ríos' }).expect(201)).body;
    const book = async (startsAt: string) =>
      (
        await http()
          .post('/api/appointments')
          .auth(owner.token, bearer)
          .send({ branchId: branch.id, serviceId: service.id, professionalId: pro.id, clientId: client.id, startsAt })
          .expect(201)
      ).body.id as string;

    const done = await book(todayAt(1));
    // Mañana a las 10: siempre es futura, sin importar la hora en que corra la prueba.
    const later = await book(new Date(Date.parse(todayAt(10)) + 86_400_000).toISOString());
    const status = (id: string, s: string) => http().post(`/api/appointments/${id}/status`).auth(owner.token, bearer).send({ status: s }).expect(201);
    await status(done, 'checked_in');
    await status(done, 'completed');
    await status(later, 'pending');

    const dash = (await http().get(`/api/dashboard?branchId=${branch.id}`).auth(owner.token, bearer).expect(200)).body;
    expect(dash.date).toBe(todayLima());
    expect(dash.kpis.appointments).toMatchObject({ today: 1, lastWeek: 0 });
    expect(dash.kpis.occupancy).toMatchObject({ bookedMinutes: 60, capacityMinutes: 1440, percent: 4 });
    expect(dash.kpis.revenue).toMatchObject({ collected: 0 });
    expect(dash.kpis.newClients.count).toBe(1);
    expect(dash.professionals).toEqual([expect.objectContaining({ displayName: 'Luis', appointments: 1, percent: 4 })]);
    expect(dash.upcoming.map((u: { id: string }) => u.id)).toContain(later);
    expect(dash.attention.map((a: { kind: string }) => a.kind).sort()).toEqual(['pending', 'unpaid']);

    // Al cobrar, el aviso desaparece y aparecen los ingresos.
    await http().post(`/api/appointments/${done}/payments`).auth(owner.token, bearer).send({ methods: [{ method: 'cash', amount: 4500 }], tip: 500 }).expect(201);
    const after = (await http().get(`/api/dashboard?branchId=${branch.id}`).auth(owner.token, bearer).expect(200)).body;
    expect(after.kpis.revenue).toMatchObject({ collected: 4500, sales: 4000, tips: 500, count: 1 });
    expect(after.attention.map((a: { kind: string }) => a.kind)).toEqual(['pending']);

    // Un profesional sin agenda vinculada no ve las citas de otros.
    const member = await sessionAsMember(ctx.app, orgId, 'professional');
    const theirs = (await http().get(`/api/dashboard?branchId=${branch.id}`).auth(member.token, bearer).expect(200)).body;
    expect(theirs.kpis.appointments.today).toBe(0);
    expect(theirs.upcoming).toHaveLength(0);
    expect(theirs.kpis.newClients).toBeNull();
  });
});
