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

async function setup() {
  const owner = await registerBusiness(ctx.app);
  const [branch] = (await http().get('/api/branches').auth(owner.token, bearer)).body;
  return { owner, branchId: branch.id as string };
}

describe('Horario de atención', () => {
  it('guarda el horario con pausa y lo copia a otra sede', async () => {
    const { owner, branchId } = await setup();
    const res = await http()
      .put(`/api/branches/${branchId}/hours`)
      .auth(owner.token, bearer)
      .send({
        days: [
          { weekday: 1, intervals: [{ start: h(14), end: h(20) }, { start: h(9), end: h(13) }] },
          { weekday: 6, intervals: [{ start: h(9), end: h(18) }] },
          { weekday: 7, intervals: [] },
        ],
      })
      .expect(200);
    expect(res.body.openingHours).toEqual([
      { weekday: 1, intervals: [{ start: h(9), end: h(13) }, { start: h(14), end: h(20) }] },
      { weekday: 6, intervals: [{ start: h(9), end: h(18) }] },
    ]);

    const other = (await http().post('/api/branches').auth(owner.token, bearer).send({ name: 'Surco' }).expect(201)).body;
    const copied = await http()
      .post(`/api/branches/${branchId}/hours/copy`)
      .auth(owner.token, bearer)
      .send({ toBranchId: other.id })
      .expect(201);
    expect(copied.body.openingHours).toEqual(res.body.openingHours);

    // Editar otra cosa de la sede no borra su horario.
    await http().patch(`/api/branches/${branchId}`).auth(owner.token, bearer).send({ phone: '987654321' }).expect(200);
    const branches = (await http().get('/api/branches').auth(owner.token, bearer)).body;
    expect(branches.find((b: { id: string }) => b.id === branchId).openingHours).toHaveLength(2);
  });

  it('rechaza bloques que se cruzan', async () => {
    const { owner, branchId } = await setup();
    const res = await http()
      .put(`/api/branches/${branchId}/hours`)
      .auth(owner.token, bearer)
      .send({ days: [{ weekday: 1, intervals: [{ start: h(9), end: h(14) }, { start: h(13), end: h(18) }] }] })
      .expect(400);
    expect(res.body.code).toBe('INVALID_SCHEDULE');
  });
});

describe('Feriados y excepciones', () => {
  it('registra días cerrados y horarios especiales, sin duplicar fechas', async () => {
    const { owner, branchId } = await setup();
    const url = `/api/branches/${branchId}/exceptions`;

    await http().post(url).auth(owner.token, bearer).send({ date: '2026-10-08', name: 'Combate de Angamos', type: 'closed' }).expect(201);
    await http()
      .post(url)
      .auth(owner.token, bearer)
      .send({ date: '2026-10-31', name: 'Halloween', type: 'custom_hours', intervals: [{ start: h(9), end: h(16) }] })
      .expect(201);

    const dup = await http().post(url).auth(owner.token, bearer).send({ date: '2026-10-08', name: 'Otra', type: 'closed' }).expect(409);
    expect(dup.body.code).toBe('EXCEPTION_EXISTS');

    // Horario especial sin bloques es inválido.
    await http().post(url).auth(owner.token, bearer).send({ date: '2026-11-02', name: 'X día', type: 'custom_hours', intervals: [] }).expect(400);

    const bulk = await http()
      .post(`${url}/bulk`)
      .auth(owner.token, bearer)
      .send({
        items: [
          { date: '2026-10-08', name: 'Combate de Angamos', type: 'closed' },
          { date: '2026-11-01', name: 'Todos los Santos', type: 'closed' },
          { date: '2026-12-25', name: 'Navidad', type: 'closed' },
        ],
      })
      .expect(200);
    expect(bulk.body).toEqual({ created: 2, skipped: 1 });

    const oct = await http().get(`${url}?from=2026-10-01&to=2026-10-31`).auth(owner.token, bearer).expect(200);
    expect(oct.body.map((e: { date: string }) => e.date)).toEqual(['2026-10-08', '2026-10-31']);

    await http().delete(`/api/branch-exceptions/${oct.body[0].id}`).auth(owner.token, bearer).expect(204);
    const all = await http().get(url).auth(owner.token, bearer).expect(200);
    expect(all.body).toHaveLength(3);
  });

  it('otro negocio no ve ni borra las excepciones', async () => {
    const { owner, branchId } = await setup();
    const created = await http()
      .post(`/api/branches/${branchId}/exceptions`)
      .auth(owner.token, bearer)
      .send({ date: '2026-12-08', name: 'Inmaculada Concepción', type: 'closed' })
      .expect(201);
    const other = await registerBusiness(ctx.app);
    await http().get(`/api/branches/${branchId}/exceptions`).auth(other.token, bearer).expect(404);
    await http().delete(`/api/branch-exceptions/${created.body.id}`).auth(other.token, bearer).expect(404);
  });
});

describe('Reglas de reserva', () => {
  it('tiene valores por defecto, se editan parcialmente y se pueden desactivar', async () => {
    const { owner } = await setup();
    const defaults = await http().get('/api/booking-rules').auth(owner.token, bearer).expect(200);
    expect(defaults.body).toMatchObject({
      minNoticeMinutes: 120,
      maxAdvanceDays: 60,
      freeCancellationHours: 12,
      maxReschedules: 2,
      defaultBufferMinutes: 10,
      maxActiveBookingsPerClient: null,
      allowOverbooking: false,
      manualApproval: 'off',
    });

    const updated = await http()
      .patch('/api/booking-rules')
      .auth(owner.token, bearer)
      .send({ minNoticeMinutes: null, maxActiveBookingsPerClient: 3, manualApproval: 'new_clients' })
      .expect(200);
    expect(updated.body).toMatchObject({
      minNoticeMinutes: null,
      maxAdvanceDays: 60,
      maxActiveBookingsPerClient: 3,
      manualApproval: 'new_clients',
    });

    await http().patch('/api/booking-rules').auth(owner.token, bearer).send({ maxAdvanceDays: 0 }).expect(400);
  });

  it('un profesional puede leer las reglas pero no cambiarlas', async () => {
    const { owner } = await setup();
    const pro = await sessionAsMember(ctx.app, owner.body.context.organizationId as string, 'professional');
    await http().get('/api/booking-rules').auth(pro.token, bearer).expect(200);
    await http().patch('/api/booking-rules').auth(pro.token, bearer).send({ maxReschedules: 5 }).expect(403);
    const [branch] = (await http().get('/api/branches').auth(owner.token, bearer)).body;
    await http().put(`/api/branches/${branch.id}/hours`).auth(pro.token, bearer).send({ days: [] }).expect(403);
  });
});
