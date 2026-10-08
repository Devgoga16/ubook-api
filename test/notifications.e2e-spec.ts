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

/** Un lunes al menos una semana en el futuro (fecha local de Lima). */
function nextMonday(): string {
  const d = new Date(Date.now() - 5 * 3_600_000 + 7 * 86_400_000);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const at = (date: string, hh: number, mm = 0) => new Date(Date.parse(`${date}T00:00:00Z`) + (h(hh, mm) + 300) * 60_000).toISOString();

async function setup() {
  const owner = await registerBusiness(ctx.app);
  const slug = (await http().get('/api/organization').auth(owner.token, bearer).expect(200)).body.slug as string;
  const [branch] = (await http().get('/api/branches').auth(owner.token, bearer)).body;
  const service = (
    await http().post('/api/services').auth(owner.token, bearer).send({ name: 'Corte clásico', durationMinutes: 30, price: 3000 }).expect(201)
  ).body;
  const hidden = (
    await http().post('/api/services').auth(owner.token, bearer).send({ name: 'Solo en local', durationMinutes: 30, price: 1000, onlineBooking: false }).expect(201)
  ).body;
  const pros: string[] = [];
  for (const name of ['Luis', 'Ana']) {
    const pro = (
      await http()
        .post('/api/professionals')
        .auth(owner.token, bearer)
        .send({ displayName: name, branchIds: [branch.id], services: [{ serviceId: service.id }, { serviceId: hidden.id }] })
        .expect(201)
    ).body;
    await http()
      .put(`/api/professionals/${pro.id}/schedule`)
      .auth(owner.token, bearer)
      .send({ branchId: branch.id, days: [{ weekday: 1, intervals: [{ start: h(9), end: h(13) }] }] })
      .expect(200);
    pros.push(pro.id);
  }
  return { owner, slug, branchId: branch.id as string, serviceId: service.id as string, hiddenId: hidden.id as string, pros, date: nextMonday() };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const client = (over: Record<string, string> = {}) => ({ firstName: 'Mateo', lastName: 'Huamán', phone: '987 654 321', email: 'mateo@cliente.test', ...over });
const book = (s: Setup, startsAt: string, extra: Record<string, unknown> = {}) =>
  http()
    .post(`/api/public/businesses/${s.slug}/bookings`)
    .send({ branchId: s.branchId, serviceId: s.serviceId, startsAt, client: client(), acceptsTerms: true, ...extra });

describe('Notificaciones del equipo', () => {
  it('avisa reservas, cambios y cancelaciones de los clientes, y se marcan como leídas', async () => {
    const s = await setup();
    const feed = async () => (await http().get('/api/notifications').auth(s.owner.token, bearer).expect(200)).body;
    expect(await feed()).toEqual({ unread: 0, items: [] });

    const { token } = (await book(s, at(s.date, 9), { professionalId: s.pros[0] }).expect(201)).body;
    let f = await feed();
    expect(f.unread).toBe(1);
    expect(f.items[0]).toMatchObject({ type: 'booking_created', title: 'Nueva reserva online', read: false });
    expect(f.items[0].body).toContain('Mateo Huamán · Corte clásico');
    expect(f.items[0].appointmentId).toEqual(expect.any(String));

    await http().post(`/api/public/bookings/${token}/reschedule`).send({ startsAt: at(s.date, 11) }).expect(200);
    await http().post(`/api/public/bookings/${token}/cancel`).send({ reason: 'Viaje' }).expect(200);
    f = await feed();
    expect(f.unread).toBe(3);
    expect(f.items.map((n: { type: string }) => n.type)).toEqual(['booking_cancelled', 'booking_rescheduled', 'booking_created']);
    expect(f.items[0].body).toContain('Motivo: Viaje');
    expect(f.items[1].body).toContain('(antes:');

    expect((await http().post('/api/notifications/read-all').auth(s.owner.token, bearer).expect(200)).body).toEqual({ unread: 0 });
    f = await feed();
    expect(f.unread).toBe(0);
    expect(f.items.every((n: { read: boolean }) => n.read)).toBe(true);
  });

  it('cada profesional ve solo los avisos de su agenda', async () => {
    const s = await setup();
    const org = (await http().get('/api/organization').auth(s.owner.token, bearer).expect(200)).body;
    const member = await sessionAsMember(ctx.app, org.id as string, 'professional');
    // Ninguno de los profesionales es suyo: no ve el aviso.
    await book(s, at(s.date, 9), { professionalId: s.pros[0] }).expect(201);
    expect((await http().get('/api/notifications').auth(member.token, bearer).expect(200)).body).toEqual({ unread: 0, items: [] });
    expect((await http().get('/api/notifications').auth(s.owner.token, bearer).expect(200)).body.unread).toBe(1);
  });

  it('la lista de espera online también avisa', async () => {
    const s = await setup();
    await http()
      .post(`/api/public/businesses/${s.slug}/waitlist`)
      .send({ branchId: s.branchId, serviceId: s.serviceId, dateFrom: s.date, dateTo: s.date, client: client(), acceptsTerms: true })
      .expect(201);
    const f = (await http().get('/api/notifications').auth(s.owner.token, bearer).expect(200)).body;
    expect(f.items[0]).toMatchObject({ type: 'waitlist_joined', title: 'Nuevo en lista de espera' });
  });
});
