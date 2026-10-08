import request from 'supertest';
import { closeTestApp, createTestApp, registerBusiness, type TestContext } from './helpers.js';

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

async function outbox() {
  const { MailService } = await import('../src/core/mail/mail.service.js');
  return ctx.app.get(MailService).outbox;
}
const lastMailTo = async (email: string) => [...(await outbox())].reverse().find((m) => m.to === email);

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

describe('Página pública de reservas', () => {
  it('muestra el negocio con sus servicios online y profesionales, sin datos privados', async () => {
    const s = await setup();
    const info = await http().get(`/api/public/businesses/${s.slug}`).expect(200);
    expect(info.body.services.map((x: { name: string }) => x.name)).toEqual(['Corte clásico']);
    expect(info.body.professionals).toHaveLength(2);
    expect(info.body.professionals[0].services).toHaveLength(1);
    expect(JSON.stringify(info.body)).not.toContain('@test.com');

    expect((await http().get('/api/public/businesses/no-existe').expect(404)).body.code).toBe('BOOKING_PAGE_UNAVAILABLE');
    const q = `branchId=${s.branchId}&serviceId=${s.hiddenId}&date=${s.date}`;
    expect((await http().get(`/api/public/businesses/${s.slug}/slots?${q}`).expect(400)).body.code).toBe('SERVICE_NOT_ONLINE');
  });

  it('reserva con "cualquiera", crea al cliente, envía confirmación y ocupa el horario', async () => {
    const s = await setup();
    const slots = await http()
      .get(`/api/public/businesses/${s.slug}/slots?branchId=${s.branchId}&serviceId=${s.serviceId}&date=${s.date}`)
      .expect(200);
    expect(slots.body.professionals).toHaveLength(2);
    expect(slots.body.professionals[0].slots).toContain(at(s.date, 9));

    const res = await book(s, at(s.date, 9), { notes: 'Primera vez' }).expect(201);
    expect(res.body.booking).toMatchObject({ status: 'confirmed', serviceName: 'Corte clásico', clientFirstName: 'Mateo', canCancel: true });
    expect(res.body.token).toMatch(/^[a-f0-9]{24}\.[\w-]{32}$/);

    const mail = (await lastMailTo('mateo@cliente.test'))!;
    expect(mail.subject).toContain('Tu cita está confirmada');
    expect(mail.text).toContain(`/reserva/${res.body.token}`);

    const list = (await http().get(`/api/appointments?branchId=${s.branchId}&from=${at(s.date, 0)}&to=${at(s.date, 23)}`).auth(s.owner.token, bearer)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ channel: 'online', notes: 'Primera vez' });
    const clients = (await http().get('/api/clients/directory').auth(s.owner.token, bearer)).body.items;
    expect(clients[0]).toMatchObject({ firstName: 'Mateo', source: 'Página de reservas', email: 'mateo@cliente.test' });

    // El otro profesional sigue libre a esa hora; los dos ocupados → no hay cupo.
    await book(s, at(s.date, 9), { client: client({ firstName: 'Rosa', phone: '911222333', email: '' }) }).expect(201);
    expect((await book(s, at(s.date, 9), { client: client({ firstName: 'Pedro', phone: '944555666' }) }).expect(409)).body.code).toBe('SLOT_TAKEN');
  });

  it('mismo celular y nombre = mismo cliente; mismo celular y otro nombre = cliente nuevo', async () => {
    const s = await setup();
    await book(s, at(s.date, 9)).expect(201);
    await book(s, at(s.date, 10)).expect(201);
    await book(s, at(s.date, 11), { client: client({ firstName: 'Mateíto', email: '' }) }).expect(201);
    const items = (await http().get('/api/clients/directory').auth(s.owner.token, bearer)).body.items as Array<{ firstName: string; phone: string }>;
    expect(items.map((c) => c.firstName).sort()).toEqual(['Mateo', 'Mateíto']);
    expect(new Set(items.map((c) => c.phone))).toEqual(new Set(['+51987654321']));
  });

  it('con aprobación manual queda pendiente y el cliente recibe aviso al aprobarla', async () => {
    const s = await setup();
    await http().patch('/api/booking-rules').auth(s.owner.token, bearer).send({ manualApproval: 'new_clients' }).expect(200);
    const res = await book(s, at(s.date, 9)).expect(201);
    expect(res.body.booking.status).toBe('pending');
    expect((await lastMailTo('mateo@cliente.test'))!.subject).toContain('Recibimos tu reserva');

    const [appt] = (await http().get(`/api/appointments?branchId=${s.branchId}&from=${at(s.date, 0)}&to=${at(s.date, 23)}`).auth(s.owner.token, bearer)).body;
    await http().post(`/api/appointments/${appt.id}/status`).auth(s.owner.token, bearer).send({ status: 'confirmed' }).expect(201);
    expect((await lastMailTo('mateo@cliente.test'))!.subject).toContain('Tu cita fue confirmada');
  });

  it('el cliente reprograma (con límite) y cancela con su enlace', async () => {
    const s = await setup();
    await http().patch('/api/booking-rules').auth(s.owner.token, bearer).send({ maxReschedules: 1 }).expect(200);
    const { token, booking } = (await book(s, at(s.date, 9), { professionalId: s.pros[0] }).expect(201)).body;
    expect(booking.professional.id).toBe(s.pros[0]);

    await http().get('/api/public/bookings/abc.def').expect(404);
    await http().get(`/api/public/bookings/${token.slice(0, -1)}x`).expect(404);

    const free = (await http().get(`/api/public/bookings/${token}/slots?date=${s.date}`).expect(200)).body.professionals[0].slots;
    expect(free).toContain(at(s.date, 9)); // su propio horario cuenta como libre
    const moved = await http().post(`/api/public/bookings/${token}/reschedule`).send({ startsAt: at(s.date, 11) }).expect(200);
    expect(moved.body).toMatchObject({ startsAt: at(s.date, 11), rescheduleCount: 1, canReschedule: false });
    expect((await lastMailTo('mateo@cliente.test'))!.subject).toContain('Cambiaste el horario');
    expect((await http().post(`/api/public/bookings/${token}/reschedule`).send({ startsAt: at(s.date, 12) }).expect(400)).body.code).toBe('RESCHEDULE_LIMIT');

    const cancelled = await http().post(`/api/public/bookings/${token}/cancel`).send({ reason: 'Viaje' }).expect(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', canCancel: false });
    expect((await lastMailTo('mateo@cliente.test'))!.subject).toContain('Cancelaste tu cita');
    await http().post(`/api/public/bookings/${token}/cancel`).send({}).expect(400);
  });

  it('respeta el máximo de citas activas por cliente y exige aceptar el uso de datos', async () => {
    const s = await setup();
    await http().patch('/api/booking-rules').auth(s.owner.token, bearer).send({ maxActiveBookingsPerClient: 1 }).expect(200);
    await book(s, at(s.date, 9), { acceptsTerms: false }).expect(400);
    await book(s, at(s.date, 9)).expect(201);
    expect((await book(s, at(s.date, 10)).expect(409)).body.code).toBe('TOO_MANY_BOOKINGS');
  });

  it('envía un solo recordatorio el día antes', async () => {
    const s = await setup();
    await book(s, at(s.date, 9), { client: client({ email: 'recordatorio@cliente.test' }) }).expect(201);
    const { BookingRemindersService } = await import('../src/modules/bookings/booking-reminders.service.js');
    const reminders = ctx.app.get(BookingRemindersService);
    const startsAt = Date.parse(at(s.date, 9));
    const before = (await outbox()).length;
    expect(await reminders.run(new Date(startsAt - 30 * 3_600_000))).toBe(0); // todavía falta
    expect(await reminders.run(new Date(startsAt - 20 * 3_600_000))).toBeGreaterThanOrEqual(1);
    expect(await reminders.run(new Date(startsAt - 19 * 3_600_000))).toBe(0);
    const sent = (await outbox()).slice(before).filter((m) => m.to === 'recordatorio@cliente.test');
    expect(sent.map((m) => m.subject)).toEqual([expect.stringContaining('Recordatorio')]);
  });
});

describe('Cupones', () => {
  it('aplica un cupón con día, horario y un uso por cliente; registra el precio de lista', async () => {
    const s = await setup();
    const promo = (
      await http()
        .post('/api/promotions')
        .auth(s.owner.token, bearer)
        .send({ code: 'lunes 20', description: 'Lunes por la mañana', type: 'percent', value: 20, serviceIds: [s.serviceId], weekdays: [1], fromMinute: 540, toMinute: 720 })
        .expect(201)
    ).body;
    expect(promo.code).toBe('LUNES20');
    await http().post('/api/promotions').auth(s.owner.token, bearer).send({ code: 'LUNES20', type: 'amount', value: 500 }).expect(409);

    const preview = await http().get(`/api/public/businesses/${s.slug}/promotions/lunes20?serviceId=${s.serviceId}`).expect(200);
    expect(preview.body).toMatchObject({ code: 'LUNES20', type: 'percent', value: 20 });
    expect((await http().get(`/api/public/businesses/${s.slug}/promotions/NOEXISTE?serviceId=${s.serviceId}`).expect(400)).body.code).toBe('PROMO_INVALID');

    const res = await book(s, at(s.date, 9), { promoCode: 'lunes20' }).expect(201);
    expect(res.body.booking).toMatchObject({ price: 2400, listPrice: 3000, promotionCode: 'LUNES20' });
    expect((await book(s, at(s.date, 10), { promoCode: 'LUNES20' }).expect(400)).body.code).toBe('PROMO_USED');
    const late = await book(s, at(s.date, 12), { promoCode: 'LUNES20', client: client({ firstName: 'Otra', phone: '955555555', email: '' }) }).expect(400);
    expect(late.body.code).toBe('PROMO_NOT_APPLICABLE');

    // Solo primera visita y con tope de usos.
    await http().post('/api/promotions').auth(s.owner.token, bearer).send({ code: 'BIENVENIDO', type: 'amount', value: 1000, newClientsOnly: true, maxUses: 1 }).expect(201);
    expect((await book(s, at(s.date, 11), { promoCode: 'BIENVENIDO', client: client({ firstName: 'Nueva', phone: '966666666', email: '' }) }).expect(201)).body.booking.price).toBe(2000);
    expect((await book(s, at(s.date, 11), { promoCode: 'BIENVENIDO', client: client({ firstName: 'Otra', phone: '977777777', email: '' }) }).expect(400)).body.code).toBe('PROMO_EXHAUSTED');

    const list = (await http().get('/api/promotions').auth(s.owner.token, bearer).expect(200)).body;
    expect(list.find((p: { code: string }) => p.code === 'LUNES20')).toMatchObject({ uses: 1, discountGiven: 600 });
  });
});

describe('Adelantos', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const listDay = (s: Setup) =>
    http().get(`/api/appointments?branchId=${s.branchId}&from=${at(s.date, 0)}&to=${at(s.date, 23)}`).auth(s.owner.token, bearer).expect(200);

  it('exige el comprobante, deja la cita por validar y al aprobar registra el cobro y confirma', async () => {
    const s = await setup();
    await http().patch(`/api/services/${s.serviceId}`).auth(s.owner.token, bearer).send({ deposit: { enabled: true, type: 'percent', value: 50 } }).expect(200);
    await http().patch('/api/organization').auth(s.owner.token, bearer).send({ depositInfo: { yape: '987 654 321 · Barbería', notes: 'Envía la captura' } }).expect(200);
    const info = (await http().get(`/api/public/businesses/${s.slug}`).expect(200)).body;
    expect(info.services.find((x: { id: string }) => x.id === s.serviceId).deposit).toEqual({ type: 'percent', value: 50 });
    expect(JSON.stringify(info)).toContain('987 654 321');

    expect((await book(s, at(s.date, 9)).expect(400)).body.code).toBe('DEPOSIT_REQUIRED');
    expect((await http().post(`/api/public/businesses/${s.slug}/uploads`).attach('file', Buffer.from('texto'), 'x.png').expect(400)).body.code).toBe('INVALID_IMAGE');
    const { key } = (await http().post(`/api/public/businesses/${s.slug}/uploads`).attach('file', PNG, 'yape.png').expect(201)).body;
    expect((await book(s, at(s.date, 9), { deposit: { proofKey: 'deposits/otro/x.png', method: 'yape' } }).expect(400)).body.code).toBe('INVALID_PROOF');

    await book(s, at(s.date, 9), { deposit: { proofKey: key, method: 'yape', reference: 'OP-777' } }).expect(201);
    const [appt] = (await listDay(s)).body;
    expect(appt.status).toBe('pending');
    expect(appt.deposit).toMatchObject({ amount: 1500, status: 'pending_review', method: 'yape', reference: 'OP-777' });
    const { url } = (await http().get(`/api/appointments/${appt.id}/deposit/proof`).auth(s.owner.token, bearer).expect(200)).body;
    await http().get(url).expect(200);

    const attention = (await http().get(`/api/dashboard?branchId=${s.branchId}`).auth(s.owner.token, bearer)).body;
    if (attention?.attention) expect(attention.attention.some((a: { kind: string }) => a.kind === 'deposit')).toBe(true);

    const approved = (await http().post(`/api/appointments/${appt.id}/deposit/approve`).auth(s.owner.token, bearer).expect(201)).body;
    expect(approved.status).toBe('confirmed');
    expect(approved.deposit.status).toBe('approved');
    const payments = (await http().get(`/api/appointments/${appt.id}/payments`).auth(s.owner.token, bearer).expect(200)).body;
    expect(JSON.stringify(payments)).toContain('OP-777');
    await http().post(`/api/appointments/${appt.id}/deposit/approve`).auth(s.owner.token, bearer).expect(400);
  });

  it('rechazar el adelanto cancela la cita y libera el horario', async () => {
    const s = await setup();
    await http().patch(`/api/services/${s.serviceId}`).auth(s.owner.token, bearer).send({ deposit: { enabled: true, type: 'fixed', value: 1000 } }).expect(200);
    const { key } = (await http().post(`/api/public/businesses/${s.slug}/uploads`).attach('file', PNG, 'yape.png').expect(201)).body;
    await book(s, at(s.date, 10), { professionalId: s.pros[0], deposit: { proofKey: key, method: 'plin' } }).expect(201);
    const [appt] = (await listDay(s)).body;
    expect(appt.deposit.amount).toBe(1000);
    const rejected = (await http().post(`/api/appointments/${appt.id}/deposit/reject`).auth(s.owner.token, bearer).send({ reason: 'No se lee' }).expect(201)).body;
    expect(rejected.status).toBe('cancelled');
    expect(rejected.deposit).toMatchObject({ status: 'rejected', rejectReason: 'No se lee' });
    // El horario vuelve a estar libre.
    await book(s, at(s.date, 10), { professionalId: s.pros[0], client: client({ email: 'otra@cliente.test', phone: '912 345 678' }), deposit: { proofKey: key, method: 'yape' } }).expect(201);
  });
});
