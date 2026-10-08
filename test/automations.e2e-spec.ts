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

async function boxes() {
  const { MailService } = await import('../src/core/mail/mail.service.js');
  const { WhatsAppService } = await import('../src/core/mail/whatsapp.service.js');
  return { mail: ctx.app.get(MailService).outbox, wa: ctx.app.get(WhatsAppService).outbox };
}
async function runner() {
  const { BookingRemindersService } = await import('../src/modules/bookings/booking-reminders.service.js');
  return ctx.app.get(BookingRemindersService);
}

async function setup(planCode?: string) {
  const owner = await registerBusiness(ctx.app, { planCode });
  const [branch] = (await http().get('/api/branches').auth(owner.token, bearer)).body;
  const service = (await http().post('/api/services').auth(owner.token, bearer).send({ name: 'Corte', durationMinutes: 30, price: 3000 }).expect(201)).body;
  const pro = (await http().post('/api/professionals').auth(owner.token, bearer).send({ displayName: 'Luis', branchIds: [branch.id], services: [{ serviceId: service.id }] }).expect(201)).body;
  await http()
    .put(`/api/professionals/${pro.id}/schedule`)
    .auth(owner.token, bearer)
    .send({ branchId: branch.id, days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, intervals: [{ start: 0, end: 1440 }] })) })
    .expect(200);
  const n = Math.floor(Math.random() * 1e8).toString().padStart(8, '0');
  const client = (
    await http()
      .post('/api/clients')
      .auth(owner.token, bearer)
      .send({ firstName: 'Ana', lastName: 'Ríos', phone: `9${n}`, email: `ana${n}@cliente.test`, marketingConsent: true })
      .expect(201)
  ).body;
  const book = (startsAt: string) =>
    http()
      .post('/api/appointments')
      .auth(owner.token, bearer)
      .send({ branchId: branch.id, serviceId: service.id, professionalId: pro.id, clientId: client.id, startsAt })
      .expect(201)
      .then((r) => r.body.id as string);
  const flow = (key: string, body: Record<string, unknown>) => http().patch(`/api/automations/${key}`).auth(owner.token, bearer).send(body);
  const status = (id: string, s: string) => http().post(`/api/appointments/${id}/status`).auth(owner.token, bearer).send({ status: s }).expect(201);
  return { owner, client, book, flow, status };
}

describe('Automatizaciones', () => {
  it('valores por defecto, validaciones y la confirmación se puede apagar', async () => {
    const s = await setup();
    const o = (await http().get('/api/automations').auth(s.owner.token, bearer).expect(200)).body;
    expect(o.flows.reminder).toMatchObject({ enabled: true, channels: ['email'], offset: 24 });
    expect(o.flows.review.enabled).toBe(false);
    expect(o.channels).toMatchObject({ email: true, whatsapp: true });

    expect((await s.flow('review', { enabled: true }).expect(400)).body.code).toBe('LINK_REQUIRED');
    expect((await s.flow('reminder', { message: 'Hola {{cliente.apellido}}' }).expect(400)).body.code).toBe('UNKNOWN_VARIABLE');
    expect((await s.flow('reminder', { offset: 100 }).expect(400)).body.code).toBe('INVALID_OFFSET');

    const { mail } = await boxes();
    const before = mail.filter((m) => m.to === s.client.email).length;
    await s.flow('confirmation', { enabled: false }).expect(200);
    await s.book(at(nextMonday(), 9));
    expect(mail.filter((m) => m.to === s.client.email).length).toBe(before);
  });

  it('manda la confirmación también por WhatsApp con el texto del negocio', async () => {
    const s = await setup();
    await s.flow('confirmation', { channels: ['email', 'whatsapp'], message: '¡Hola {{cliente.nombre}}! Te esperamos el {{cita.fecha}} a las {{cita.hora}}.' }).expect(200);
    await s.book(at(nextMonday(), 10));
    const { wa, mail } = await boxes();
    const msg = wa.find((m) => m.to === s.client.phone)!;
    expect(msg.text).toMatch(/^¡Hola Ana! Te esperamos el lunes \d+ de \w+ a las 10:00\.$/);
    expect(mail.find((m) => m.to === s.client.email)!.subject).toContain('Tu cita está confirmada');

    const log = (await http().get('/api/automations/log').auth(s.owner.token, bearer).expect(200)).body;
    expect(log.map((l: { channel: string }) => l.channel).sort()).toEqual(['email', 'whatsapp']);
    expect(log[0]).toMatchObject({ flow: 'confirmation', status: 'sent', clientName: 'Ana Ríos' });
  });

  it('pide reseña unas horas después y avisa cuando el cliente no vino', async () => {
    const s = await setup();
    await s.flow('review', { enabled: true, offset: 2, link: 'https://g.page/r/mi-negocio/review' }).expect(200);
    await s.flow('noShow', { enabled: true }).expect(200);
    const date = nextMonday();
    const done = await s.book(at(date, 9));
    await s.status(done, 'checked_in');
    await s.status(done, 'completed');

    const r = await runner();
    const endsAt = Date.parse(at(date, 9)) + 30 * 60_000;
    expect(await r.runReviews(new Date(endsAt + 60 * 60_000))).toBe(0); // todavía no
    expect(await r.runReviews(new Date(endsAt + 3 * 3_600_000))).toBe(1);
    expect(await r.runReviews(new Date(endsAt + 4 * 3_600_000))).toBe(0); // una sola vez
    const { mail } = await boxes();
    const review = mail.filter((m) => m.to === s.client.email).find((m) => m.subject.startsWith('¿Cómo te fue?'))!;
    expect(review.text).toContain('https://g.page/r/mi-negocio/review');

    const missed = await s.book(at(date, 11));
    await s.status(missed, 'no_show');
    expect(mail.filter((m) => m.to === s.client.email).at(-1)!.subject).toContain('Te esperábamos hoy');
  });

  it('saluda en el cumpleaños con cupón, una vez al día, solo a quien aceptó promociones', async () => {
    const s = await setup();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
    await http().patch(`/api/clients/${s.client.id}`).auth(s.owner.token, bearer).send({ birthDate: `1990-${today.slice(5)}` }).expect(200);
    await s.flow('birthday', { enabled: true, promoCode: 'CUMPLE25' }).expect(200);
    const r = await runner();
    const elevenAm = new Date(Date.parse(`${today}T16:00:00Z`)); // 11:00 en Lima
    expect(await r.runDaily(elevenAm)).toBeGreaterThanOrEqual(1);
    expect(await r.runDaily(new Date(elevenAm.getTime() + 3_600_000))).toBe(0);
    const { mail } = await boxes();
    const greet = mail.filter((m) => m.to === s.client.email).find((m) => m.subject.startsWith('¡Feliz cumpleaños!'))!;
    expect(greet.text).toContain('CUMPLE25');

    // Envío de prueba al dueño, con datos de ejemplo.
    const test = (await http().post('/api/automations/birthday/test').auth(s.owner.token, bearer).expect(201)).body;
    expect(test).toMatchObject({ email: true });
    expect(test.text).toContain('CUMPLE25');
  });
});
