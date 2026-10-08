import request from 'supertest';
import { closeTestApp, createTestApp, registerBusiness, sessionAsMember, type Session, type TestContext } from './helpers.js';

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

/** Un lunes al menos una semana en el futuro (fecha local de Lima). */
function nextMonday(): string {
  const d = new Date(Date.now() - 5 * 3_600_000 + 7 * 86_400_000);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
/** "2026-10-12" + 9:00 en Lima → ISO UTC. */
const at = (date: string, hh: number, mm = 0) => new Date(Date.parse(`${date}T00:00:00Z`) + (h(hh, mm) + 300) * 60_000).toISOString();

async function setup() {
  const owner = await registerBusiness(ctx.app);
  const [branch] = (await http().get('/api/branches').auth(owner.token, bearer)).body;
  const service = (
    await http()
      .post('/api/services')
      .auth(owner.token, bearer)
      .send({ name: 'Corte + barba', durationMinutes: 45, price: 5000, bufferAfterMinutes: 10 })
      .expect(201)
  ).body;
  const pro = (
    await http()
      .post('/api/professionals')
      .auth(owner.token, bearer)
      .send({ displayName: 'Luis Paredes', branchIds: [branch.id], services: [{ serviceId: service.id, price: 5500 }] })
      .expect(201)
  ).body;
  await http()
    .put(`/api/professionals/${pro.id}/schedule`)
    .auth(owner.token, bearer)
    .send({ branchId: branch.id, days: [{ weekday: 1, intervals: [{ start: h(9), end: h(13) }, { start: h(14), end: h(19) }] }] })
    .expect(200);
  const client = (
    await http().post('/api/clients').auth(owner.token, bearer).send({ firstName: 'Mateo', lastName: 'Huamán', phone: '987 654 321' }).expect(201)
  ).body;
  return { owner, branchId: branch.id as string, serviceId: service.id as string, proId: pro.id as string, clientId: client.id as string, date: nextMonday() };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function slots(s: Setup, session: Session = s.owner) {
  return http()
    .get(`/api/availability?branchId=${s.branchId}&serviceId=${s.serviceId}&date=${s.date}`)
    .auth(session.token, bearer)
    .expect(200)
    .then((r) => r.body.professionals[0].slots as Array<{ start: string; available: boolean }>);
}

function book(s: Setup, startsAt: string, session: Session = s.owner, extra: Record<string, unknown> = {}) {
  return http()
    .post('/api/appointments')
    .auth(session.token, bearer)
    .send({ branchId: s.branchId, serviceId: s.serviceId, professionalId: s.proId, clientId: s.clientId, startsAt, ...extra });
}

const isFree = (list: Array<{ start: string; available: boolean }>, iso: string) => list.find((x) => x.start === iso)?.available;

describe('Clientes', () => {
  it('normaliza el celular, avisa si se repite y busca sin tildes', async () => {
    const { owner, clientId } = await setup();
    const dup = await http().post('/api/clients').auth(owner.token, bearer).send({ firstName: 'Otro', phone: '+51987654321' }).expect(409);
    expect(dup.body).toMatchObject({ code: 'CLIENT_PHONE_TAKEN', details: { clientId, name: 'Mateo Huamán' } });

    const byName = await http().get('/api/clients?search=huaman').auth(owner.token, bearer).expect(200);
    expect(byName.body.map((c: { id: string }) => c.id)).toEqual([clientId]);
    expect(byName.body[0].phone).toBe('+51987654321');
    const byPhone = await http().get('/api/clients?search=654%20321').auth(owner.token, bearer).expect(200);
    expect(byPhone.body).toHaveLength(1);
    expect((await http().get('/api/clients?search=zzz').auth(owner.token, bearer)).body).toHaveLength(0);
  });

  it('el celular se comparte si confirman que es otra persona; el DNI no se repite', async () => {
    const { owner, clientId } = await setup();
    const post = (body: Record<string, unknown>) => http().post('/api/clients').auth(owner.token, bearer).send(body);

    // Hijo con el celular de la mamá.
    const son = await post({ firstName: 'Mateíto', phone: '987654321', allowSharedPhone: true, documentId: '7654 3210' }).expect(201);
    expect(son.body).toMatchObject({ phone: '+51987654321', documentId: '76543210' });

    // Editar a Mateo sin tocar el celular no avisa nada.
    await http().patch(`/api/clients/${clientId}`).auth(owner.token, bearer).send({ phone: '987 654 321', notes: 'ok' }).expect(200);

    const dni = await post({ firstName: 'Otra', documentId: '76543210' }).expect(409);
    expect(dni.body).toMatchObject({ code: 'CLIENT_DOCUMENT_TAKEN', details: { clientId: son.body.id } });
    // Normalizado: con puntos o espacios sigue siendo el mismo.
    expect((await post({ firstName: 'Otra', documentId: '76.543.210' }).expect(409)).body.code).toBe('CLIENT_DOCUMENT_TAKEN');
    const taken = await http().patch(`/api/clients/${clientId}`).auth(owner.token, bearer).send({ documentId: '76543210' }).expect(409);
    expect(taken.body.code).toBe('CLIENT_DOCUMENT_TAKEN');

    // Vacío = sin documento: varios clientes pueden no tenerlo.
    await post({ firstName: 'Sin DNI 1', documentId: '' }).expect(201);
    await post({ firstName: 'Sin DNI 2', documentId: '' }).expect(201);
  });
});

describe('Disponibilidad y citas', () => {
  it('agenda una cita con el precio del profesional y ocupa el horario con su limpieza', async () => {
    const s = await setup();
    const before = await slots(s);
    expect(isFree(before, at(s.date, 9))).toBe(true);
    expect(before.some((x) => x.start === at(s.date, 13))).toBe(false); // descanso 13–14

    const created = await book(s, at(s.date, 9), s.owner, { notes: 'Fade bajo' }).expect(201);
    expect(created.body).toMatchObject({
      number: 1001,
      status: 'confirmed',
      price: 5500,
      durationMinutes: 45,
      serviceName: 'Corte + barba',
      endsAt: at(s.date, 9, 45),
      client: { firstName: 'Mateo', lastName: 'Huamán' },
    });

    const after = await slots(s);
    expect(isFree(after, at(s.date, 9))).toBe(false);
    expect(isFree(after, at(s.date, 9, 45))).toBe(false); // ocupado hasta 9:55 por la limpieza
    expect(isFree(after, at(s.date, 10))).toBe(true);

    expect((await book(s, at(s.date, 9, 15)).expect(409)).body.code).toBe('SLOT_TAKEN');
    expect((await book(s, at(s.date, 13, 30)).expect(409)).body.code).toBe('SLOT_UNAVAILABLE');
    expect((await book(s, at(s.date, 10)).expect(201)).body.number).toBe(1002);
  });

  it('dos reservas simultáneas al mismo horario: solo una entra', async () => {
    const s = await setup();
    const results = await Promise.all([book(s, at(s.date, 11)), book(s, at(s.date, 11)), book(s, at(s.date, 11))]);
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([201, 409, 409]);
  });

  it('cambia de estado siguiendo el flujo y cancelar libera el horario', async () => {
    const s = await setup();
    const a = (await book(s, at(s.date, 9)).expect(201)).body;
    const go = (id: string, status: string) => http().post(`/api/appointments/${id}/status`).auth(s.owner.token, bearer).send({ status });

    await go(a.id, 'checked_in').expect(201);
    await go(a.id, 'in_progress').expect(201);
    const done = await go(a.id, 'completed').expect(201);
    expect(done.body.history.map((x: { status: string }) => x.status)).toEqual(['confirmed', 'checked_in', 'in_progress', 'completed']);
    expect((await go(a.id, 'cancelled').expect(400)).body.code).toBe('INVALID_TRANSITION');

    const b = (await book(s, at(s.date, 11)).expect(201)).body;
    await go(b.id, 'cancelled').expect(201);
    expect(isFree(await slots(s), at(s.date, 11))).toBe(true);
  });

  it('reprograma a otro horario libre', async () => {
    const s = await setup();
    const a = (await book(s, at(s.date, 15)).expect(201)).body;
    const moved = await http()
      .post(`/api/appointments/${a.id}/reschedule`)
      .auth(s.owner.token, bearer)
      .send({ startsAt: at(s.date, 16) })
      .expect(201);
    expect(moved.body).toMatchObject({ startsAt: at(s.date, 16), rescheduleCount: 1 });
    const list = await slots(s);
    expect(isFree(list, at(s.date, 15))).toBe(true);
    expect(isFree(list, at(s.date, 16))).toBe(false);

    // Moverla "a sí misma" un poco más tarde no choca con su propio horario.
    await http().post(`/api/appointments/${a.id}/reschedule`).auth(s.owner.token, bearer).send({ startsAt: at(s.date, 16, 15) }).expect(201);
  });

  it('feriados, ausencias y horario de la sede quitan horarios', async () => {
    const s = await setup();
    await http().put(`/api/branches/${s.branchId}/hours`).auth(s.owner.token, bearer).send({ days: [{ weekday: 1, intervals: [{ start: h(10), end: h(18) }] }] }).expect(200);
    const list = await slots(s);
    expect(list[0]!.start).toBe(at(s.date, 10));
    expect(list.some((x) => x.start === at(s.date, 18))).toBe(false);

    await http()
      .post(`/api/professionals/${s.proId}/time-off`)
      .auth(s.owner.token, bearer)
      .send({ type: 'personal', startsAt: at(s.date, 10), endsAt: at(s.date, 12) })
      .expect(201);
    expect((await slots(s))[0]!.start).toBe(at(s.date, 12));

    await http().post(`/api/branches/${s.branchId}/exceptions`).auth(s.owner.token, bearer).send({ date: s.date, name: 'Feriado', type: 'closed' }).expect(201);
    expect(await slots(s)).toEqual([]);
  });

  it('el calendario resume horarios libres por día', async () => {
    const s = await setup();
    const res = await http()
      .get(`/api/availability/days?branchId=${s.branchId}&serviceId=${s.serviceId}&from=${s.date}&to=${s.date.replace(/\d\d$/, (d) => String(Number(d)).padStart(2, '0'))}`)
      .auth(s.owner.token, bearer)
      .expect(200);
    expect(res.body.days[0]).toMatchObject({ date: s.date, free: expect.any(Number) });
    expect(res.body.days[0].free).toBeGreaterThan(10);
  });

  it('la agenda lista las citas del día con el cliente; otro negocio no las ve', async () => {
    const s = await setup();
    await book(s, at(s.date, 9)).expect(201);
    const day = await http()
      .get(`/api/appointments?branchId=${s.branchId}&from=${at(s.date, 0)}&to=${at(s.date, 23, 59)}`)
      .auth(s.owner.token, bearer)
      .expect(200);
    expect(day.body).toHaveLength(1);
    expect(day.body[0].client.firstName).toBe('Mateo');

    const other = await registerBusiness(ctx.app);
    await http().get(`/api/appointments/${day.body[0].id}`).auth(other.token, bearer).expect(404);
  });

  it('un profesional solo ve y agenda en su propia agenda', async () => {
    const s = await setup();
    const orgId = s.owner.body.context.organizationId as string;
    const member = await sessionAsMember(ctx.app, orgId, 'professional');
    const membershipId = (await http().get('/api/auth/me').auth(member.token, bearer)).body.access.membershipId;
    await http().patch(`/api/professionals/${s.proId}`).auth(s.owner.token, bearer).send({ membershipId }).expect(200);

    // Otro profesional del negocio, con una cita.
    const andrea = (
      await http()
        .post('/api/professionals')
        .auth(s.owner.token, bearer)
        .send({ displayName: 'Andrea Quispe', branchIds: [s.branchId], services: [{ serviceId: s.serviceId }] })
        .expect(201)
    ).body;
    await http()
      .put(`/api/professionals/${andrea.id}/schedule`)
      .auth(s.owner.token, bearer)
      .send({ branchId: s.branchId, days: [{ weekday: 1, intervals: [{ start: h(9), end: h(18) }] }] })
      .expect(200);
    await book(s, at(s.date, 9), s.owner, { professionalId: andrea.id }).expect(201);
    await book(s, at(s.date, 10)).expect(201); // de Luis

    const visible = await http()
      .get(`/api/appointments?branchId=${s.branchId}&from=${at(s.date, 0)}&to=${at(s.date, 23, 59)}`)
      .auth(member.token, bearer)
      .expect(200);
    expect(visible.body.map((a: { professionalId: string }) => a.professionalId)).toEqual([s.proId]);

    // Puede agendar en su propia agenda, pero no en la de otro profesional.
    await book(s, at(s.date, 12), member).expect(201);
    const denied = await book(s, at(s.date, 12), member, { professionalId: andrea.id }).expect(403);
    expect(denied.body.message).toMatch(/propia agenda/);
  });
});

describe('Gestión de la cita', () => {
  it('cambia servicio y profesional: recalcula precio y duración y deja registro', async () => {
    const s = await setup();
    const clasico = (
      await http().post('/api/services').auth(s.owner.token, bearer).send({ name: 'Corte clásico', durationMinutes: 30, price: 3500 }).expect(201)
    ).body;
    const andrea = (
      await http()
        .post('/api/professionals')
        .auth(s.owner.token, bearer)
        .send({ displayName: 'Andrea Quispe', branchIds: [s.branchId], services: [{ serviceId: clasico.id }, { serviceId: s.serviceId }] })
        .expect(201)
    ).body;
    await http()
      .put(`/api/professionals/${andrea.id}/schedule`)
      .auth(s.owner.token, bearer)
      .send({ branchId: s.branchId, days: [{ weekday: 1, intervals: [{ start: h(9), end: h(18) }] }] })
      .expect(200);

    const a = (await book(s, at(s.date, 9)).expect(201)).body; // Corte + barba con Luis: S/ 55, 45 min
    const changed = await http()
      .post(`/api/appointments/${a.id}/reschedule`)
      .auth(s.owner.token, bearer)
      .send({ startsAt: at(s.date, 9), professionalId: andrea.id, serviceId: clasico.id })
      .expect(201);
    expect(changed.body).toMatchObject({
      professionalId: andrea.id,
      serviceName: 'Corte clásico',
      price: 3500,
      durationMinutes: 30,
      endsAt: at(s.date, 9, 30),
      rescheduleCount: 0, // misma hora: no cuenta como reprogramación
    });
    expect(changed.body.history.at(-1).note).toMatch(/Profesional: Luis Paredes → Andrea Quispe · Servicio: Corte \+ barba → Corte clásico/);

    // Luis quedó libre a esa hora.
    const free = await slots(s);
    expect(isFree(free.length ? free : [], at(s.date, 9))).toBe(true);
  });

  it('cambia el cliente y muestra el historial del cliente', async () => {
    const s = await setup();
    const valeria = (
      await http().post('/api/clients').auth(s.owner.token, bearer).send({ firstName: 'Valeria', lastName: 'Ríos', phone: '956112450' }).expect(201)
    ).body;
    const a = (await book(s, at(s.date, 9)).expect(201)).body;
    const b = (await book(s, at(s.date, 11)).expect(201)).body;
    await http().post(`/api/appointments/${b.id}/status`).auth(s.owner.token, bearer).send({ status: 'no_show' }).expect(201);

    const moved = await http().patch(`/api/appointments/${a.id}`).auth(s.owner.token, bearer).send({ clientId: valeria.id }).expect(200);
    expect(moved.body.client.firstName).toBe('Valeria');
    expect(moved.body.history.at(-1).note).toBe('Cliente cambiado a Valeria Ríos');

    const history = await http().get(`/api/clients/${s.clientId}/appointments`).auth(s.owner.token, bearer).expect(200);
    expect(history.body.stats).toMatchObject({ total: 1, noShows: 1, completed: 0 });
    expect(history.body.upcoming).toHaveLength(0);
    expect(history.body.past.map((x: { id: string }) => x.id)).toEqual([b.id]);

    const vh = await http().get(`/api/clients/${valeria.id}/appointments`).auth(s.owner.token, bearer).expect(200);
    expect(vh.body.upcoming.map((x: { id: string }) => x.id)).toEqual([a.id]);
  });
});

describe('Sucursales', () => {
  it('guarda referencia y mapa, valida el enlace y no desactiva una sede con citas próximas', async () => {
    const s = await setup();
    const second = (
      await http()
        .post('/api/branches')
        .auth(s.owner.token, bearer)
        .send({ name: 'Sede San Isidro', address: 'Av. Camino Real 123', reference: 'Frente al parque', mapsUrl: 'https://maps.app.goo.gl/abc123' })
        .expect(201)
    ).body;
    expect(second).toMatchObject({ reference: 'Frente al parque', mapsUrl: 'https://maps.app.goo.gl/abc123' });
    await http().patch(`/api/branches/${second.id}`).auth(s.owner.token, bearer).send({ mapsUrl: 'no-es-un-enlace' }).expect(400);
    await http().patch(`/api/branches/${second.id}`).auth(s.owner.token, bearer).send({ mapsUrl: '' }).expect(200);

    await book(s, at(s.date, 9)).expect(201);
    const blocked = await http().patch(`/api/branches/${s.branchId}`).auth(s.owner.token, bearer).send({ isActive: false }).expect(409);
    expect(blocked.body).toMatchObject({ code: 'BRANCH_HAS_APPOINTMENTS', details: { upcoming: 1 } });
    await http().patch(`/api/branches/${second.id}`).auth(s.owner.token, bearer).send({ isActive: false }).expect(200);
  });
});
