import request from 'supertest';
import {
  closeTestApp,
  createTestApp,
  registerBusiness,
  sessionAsMember,
  type Session,
  type TestContext,
} from './helpers.js';

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

async function setup(planCode?: string) {
  const owner = await registerBusiness(ctx.app, planCode ? { planCode } : {});
  const [branch] = (await http().get('/api/branches').auth(owner.token, bearer)).body;
  const service = (
    await http()
      .post('/api/services')
      .auth(owner.token, bearer)
      .send({ name: 'Corte clásico', durationMinutes: 30, price: 3500 })
  ).body;
  return { owner, branchId: branch.id as string, serviceId: service.id as string };
}

function createPro(session: Session, body: Record<string, unknown>) {
  return http().post('/api/professionals').auth(session.token, bearer).send(body);
}

describe('Profesionales', () => {
  it('crea un profesional con sedes y servicios con precio propio', async () => {
    const { owner, branchId, serviceId } = await setup();
    const res = await createPro(owner, {
      displayName: 'Luis Paredes',
      title: 'Barbero senior',
      branchIds: [branchId],
      services: [{ serviceId, price: 4000 }],
      commissionPercent: 45,
    }).expect(201);
    expect(res.body).toMatchObject({
      displayName: 'Luis Paredes',
      branchIds: [branchId],
      services: [{ serviceId, price: 4000, durationMinutes: null }],
      commissionPercent: 45,
      isActive: true,
      membershipId: null,
    });

    const list = await http().get('/api/professionals').auth(owner.token, bearer).expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('valida sedes y servicios', async () => {
    const { owner, branchId, serviceId } = await setup();
    expect((await createPro(owner, { displayName: 'Sin sede', branchIds: [] }).expect(400)).body.code).toBe('BRANCH_REQUIRED');
    expect(
      (await createPro(owner, { displayName: 'Xavier', branchIds: ['0123456789abcdef01234567'] }).expect(400)).body.code,
    ).toBe('INVALID_BRANCH');

    await http().patch(`/api/services/${serviceId}`).auth(owner.token, bearer).send({ isArchived: true }).expect(200);
    expect(
      (await createPro(owner, { displayName: 'Xavier', branchIds: [branchId], services: [{ serviceId }] }).expect(400)).body.code,
    ).toBe('INVALID_SERVICE');
  });

  it('respeta el límite de profesionales del plan (Starter: 2)', async () => {
    const { owner, branchId } = await setup('starter');
    const a = await createPro(owner, { displayName: 'Uno', branchIds: [branchId] }).expect(201);
    await createPro(owner, { displayName: 'Dos', branchIds: [branchId] }).expect(201);
    const third = await createPro(owner, { displayName: 'Tres', branchIds: [branchId] }).expect(403);
    expect(third.body.code).toBe('PLAN_LIMIT_REACHED');

    // Desactivar libera el cupo; reactivar vuelve a contarlo.
    await http().patch(`/api/professionals/${a.body.id}`).auth(owner.token, bearer).send({ isActive: false }).expect(200);
    await createPro(owner, { displayName: 'Tres', branchIds: [branchId] }).expect(201);
    await http().patch(`/api/professionals/${a.body.id}`).auth(owner.token, bearer).send({ isActive: true }).expect(403);
  });

  it('otro negocio no ve al profesional', async () => {
    const { owner, branchId } = await setup();
    const pro = await createPro(owner, { displayName: 'Luis', branchIds: [branchId] }).expect(201);
    const other = await registerBusiness(ctx.app);
    await http().get(`/api/professionals/${pro.body.id}`).auth(other.token, bearer).expect(404);
    expect((await http().get('/api/professionals').auth(other.token, bearer)).body).toHaveLength(0);
  });
});

describe('Horario semanal', () => {
  it('guarda bloques con descanso y valida cruces', async () => {
    const { owner, branchId } = await setup();
    const pro = (await createPro(owner, { displayName: 'Luis', branchIds: [branchId] })).body;
    const url = `/api/professionals/${pro.id}/schedule`;

    const saved = await http()
      .put(url)
      .auth(owner.token, bearer)
      .send({
        branchId,
        days: [
          { weekday: 1, intervals: [{ start: h(14), end: h(19) }, { start: h(9), end: h(13) }] },
          { weekday: 7, intervals: [] },
        ],
      })
      .expect(200);
    expect(saved.body.schedules).toEqual([
      { branchId, days: [{ weekday: 1, intervals: [{ start: h(9), end: h(13) }, { start: h(14), end: h(19) }] }] },
    ]);

    const overlap = await http()
      .put(url)
      .auth(owner.token, bearer)
      .send({ branchId, days: [{ weekday: 1, intervals: [{ start: h(9), end: h(13) }, { start: h(12), end: h(15) }] }] })
      .expect(400);
    expect(overlap.body.code).toBe('INVALID_SCHEDULE');
  });

  it('no permite el mismo horario en dos sedes, ni sedes no asignadas', async () => {
    const { owner, branchId } = await setup();
    const surco = (await http().post('/api/branches').auth(owner.token, bearer).send({ name: 'Surco' }).expect(201)).body;
    const other = (await http().post('/api/branches').auth(owner.token, bearer).send({ name: 'San Isidro' }).expect(201)).body;
    const pro = (await createPro(owner, { displayName: 'Luis', branchIds: [branchId, surco.id] })).body;
    const url = `/api/professionals/${pro.id}/schedule`;

    await http()
      .put(url)
      .auth(owner.token, bearer)
      .send({ branchId, days: [{ weekday: 2, intervals: [{ start: h(9), end: h(13) }] }] })
      .expect(200);
    const clash = await http()
      .put(url)
      .auth(owner.token, bearer)
      .send({ branchId: surco.id, days: [{ weekday: 2, intervals: [{ start: h(12), end: h(18) }] }] })
      .expect(400);
    expect(clash.body).toMatchObject({ code: 'SCHEDULE_OVERLAP', message: expect.stringContaining('martes') });

    await http()
      .put(url)
      .auth(owner.token, bearer)
      .send({ branchId: surco.id, days: [{ weekday: 2, intervals: [{ start: h(14), end: h(18) }] }] })
      .expect(200);

    const notAssigned = await http()
      .put(url)
      .auth(owner.token, bearer)
      .send({ branchId: other.id, days: [] })
      .expect(400);
    expect(notAssigned.body.code).toBe('BRANCH_NOT_ASSIGNED');

    // Quitar una sede elimina su horario.
    const updated = await http()
      .patch(`/api/professionals/${pro.id}`)
      .auth(owner.token, bearer)
      .send({ branchIds: [branchId] })
      .expect(200);
    expect(updated.body.schedules).toHaveLength(1);
    expect(updated.body.schedules[0].branchId).toBe(branchId);
  });
});

describe('Ausencias y alcance "propio"', () => {
  it('el profesional pide ausencias para sí (pendientes) y el dueño las aprueba', async () => {
    const { owner, branchId } = await setup();
    const orgId = owner.body.context.organizationId as string;
    const member = await sessionAsMember(ctx.app, orgId, 'professional');
    const memberMe = await http().get('/api/auth/me').auth(member.token, bearer).expect(200);

    const mine = (
      await createPro(owner, { displayName: 'Diego', branchIds: [branchId], membershipId: memberMe.body.access.membershipId }).expect(201)
    ).body;
    const someoneElse = (await createPro(owner, { displayName: 'Andrea', branchIds: [branchId] }).expect(201)).body;

    // Ese usuario ya está vinculado.
    expect(
      (await createPro(owner, { displayName: 'Otro', branchIds: [branchId], membershipId: memberMe.body.access.membershipId }).expect(409)).body.code,
    ).toBe('MEMBER_ALREADY_LINKED');

    const range = { startsAt: '2026-10-19T05:00:00.000Z', endsAt: '2026-10-27T05:00:00.000Z' };

    // Sin professional.read, la lista trae solo su propio perfil.
    const own = await http().get('/api/professionals').auth(member.token, bearer).expect(200);
    expect(own.body.map((p: { id: string }) => p.id)).toEqual([mine.id]);

    // Puede ver su perfil aunque no tenga professional.read, pero no el de otros.
    await http().get(`/api/professionals/${mine.id}`).auth(member.token, bearer).expect(200);
    await http().get(`/api/professionals/${someoneElse.id}`).auth(member.token, bearer).expect(403);

    // Su propio horario sí, el de otro no.
    await http()
      .put(`/api/professionals/${mine.id}/schedule`)
      .auth(member.token, bearer)
      .send({ branchId, days: [{ weekday: 1, intervals: [{ start: h(9), end: h(17) }] }] })
      .expect(200);
    await http()
      .put(`/api/professionals/${someoneElse.id}/schedule`)
      .auth(member.token, bearer)
      .send({ branchId, days: [] })
      .expect(403);

    const request1 = await http()
      .post(`/api/professionals/${mine.id}/time-off`)
      .auth(member.token, bearer)
      .send({ type: 'vacation', title: 'Vacaciones', ...range })
      .expect(201);
    expect(request1.body.status).toBe('pending');

    await http()
      .post(`/api/professionals/${someoneElse.id}/time-off`)
      .auth(member.token, bearer)
      .send({ type: 'vacation', ...range })
      .expect(403);

    // No puede aprobarse a sí mismo.
    await http().patch(`/api/time-off/${request1.body.id}`).auth(member.token, bearer).send({ status: 'approved' }).expect(403);

    const approved = await http()
      .patch(`/api/time-off/${request1.body.id}`)
      .auth(owner.token, bearer)
      .send({ status: 'approved' })
      .expect(200);
    expect(approved.body.status).toBe('approved');

    // Aprobada, ya no la puede retirar él; el dueño sí.
    await http().delete(`/api/time-off/${request1.body.id}`).auth(member.token, bearer).expect(403);

    // La que registra el dueño queda aprobada directamente.
    const byOwner = await http()
      .post(`/api/professionals/${someoneElse.id}/time-off`)
      .auth(owner.token, bearer)
      .send({ type: 'training', title: 'Capacitación', ...range })
      .expect(201);
    expect(byOwner.body.status).toBe('approved');

    const list = await http()
      .get(`/api/professionals/${mine.id}/time-off?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z`)
      .auth(member.token, bearer)
      .expect(200);
    expect(list.body).toHaveLength(1);

    await http().delete(`/api/time-off/${request1.body.id}`).auth(owner.token, bearer).expect(204);
  });

  it('valida el rango de fechas', async () => {
    const { owner, branchId } = await setup();
    const pro = (await createPro(owner, { displayName: 'Luis', branchIds: [branchId] })).body;
    const res = await http()
      .post(`/api/professionals/${pro.id}/time-off`)
      .auth(owner.token, bearer)
      .send({ type: 'personal', startsAt: '2026-10-20T15:00:00Z', endsAt: '2026-10-20T14:00:00Z' })
      .expect(400);
    expect(res.body.code).toBe('INVALID_RANGE');
  });
});
