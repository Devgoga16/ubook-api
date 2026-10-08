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

async function outbox() {
  const { MailService } = await import('../src/core/mail/mail.service.js');
  return ctx.app.get(MailService).outbox;
}

describe('Lista de espera', () => {
  it('muestra horarios que le sirven cuando se liberan, avisa y agenda desde la lista', async () => {
    const owner = await registerBusiness(ctx.app);
    const slug = (await http().get('/api/organization').auth(owner.token, bearer)).body.slug as string;
    const [branch] = (await http().get('/api/branches').auth(owner.token, bearer)).body;
    const service = (await http().post('/api/services').auth(owner.token, bearer).send({ name: 'Masaje', durationMinutes: 60, price: 9000 }).expect(201)).body;
    const pro = (
      await http().post('/api/professionals').auth(owner.token, bearer).send({ displayName: 'Rosa', branchIds: [branch.id], services: [{ serviceId: service.id }] }).expect(201)
    ).body;
    // Solo un turno los lunes: 9:00–10:00.
    await http()
      .put(`/api/professionals/${pro.id}/schedule`)
      .auth(owner.token, bearer)
      .send({ branchId: branch.id, days: [{ weekday: 1, intervals: [{ start: 540, end: 600 }] }] })
      .expect(200);
    const date = nextMonday();
    const mk = (firstName: string, phone: string, email?: string) =>
      http().post('/api/clients').auth(owner.token, bearer).send({ firstName, lastName: 'Test', phone, email }).expect(201).then((r) => r.body.id as string);
    const first = await mk('Ana', '911111111');
    const waiting = await mk('Bea', '922222222', 'bea@cliente.test');

    const taken = (
      await http()
        .post('/api/appointments')
        .auth(owner.token, bearer)
        .send({ branchId: branch.id, serviceId: service.id, professionalId: pro.id, clientId: first, startsAt: at(date, 9) })
        .expect(201)
    ).body;

    await http()
      .post('/api/waitlist')
      .auth(owner.token, bearer)
      .send({ branchId: branch.id, serviceId: service.id, clientId: waiting, dateFrom: date, dateTo: date, timeOfDay: 'morning', notes: 'Prefiere temprano' })
      .expect(201);
    // Otra persona que solo puede en la tarde: nunca le sirve.
    await http()
      .post(`/api/public/businesses/${slug}/waitlist`)
      .send({ branchId: branch.id, serviceId: service.id, dateFrom: date, dateTo: date, timeOfDay: 'afternoon', client: { firstName: 'Caro', lastName: 'Web', phone: '933333333' }, acceptsTerms: true })
      .expect(201);

    let list = (await http().get(`/api/waitlist?branchId=${branch.id}`).auth(owner.token, bearer).expect(200)).body;
    expect(list).toHaveLength(2);
    expect(list.every((e: { options: unknown[] }) => e.options.length === 0)).toBe(true);
    const bea = list.find((e: { client: { name: string } }) => e.client.name === 'Bea Test');
    expect((await http().post(`/api/waitlist/${bea.id}/notify`).auth(owner.token, bearer).expect(400)).body.code).toBe('NO_OPTIONS');

    // Se cancela la cita: a Bea le sirve, a Caro no (es en la mañana).
    await http().post(`/api/appointments/${taken.id}/status`).auth(owner.token, bearer).send({ status: 'cancelled' }).expect(201);
    list = (await http().get(`/api/waitlist?branchId=${branch.id}`).auth(owner.token, bearer).expect(200)).body;
    const options = list.find((e: { id: string }) => e.id === bea.id).options;
    expect(options).toEqual([expect.objectContaining({ startsAt: at(date, 9), professionalName: 'Rosa' })]);
    expect(list.find((e: { client: { name: string } }) => e.client.name === 'Caro Web')).toMatchObject({ source: 'online', options: [] });

    const notice = (await http().post(`/api/waitlist/${bea.id}/notify`).auth(owner.token, bearer).expect(201)).body;
    expect(notice).toMatchObject({ emailSent: true, phone: '+51922222222' });
    expect(notice.whatsappText).toContain('Masaje');
    expect([...(await outbox())].reverse().find((m) => m.to === 'bea@cliente.test')!.subject).toContain('Se liberó un horario');

    const appt = (await http().post(`/api/waitlist/${bea.id}/book`).auth(owner.token, bearer).send({ professionalId: pro.id, startsAt: at(date, 9) }).expect(201)).body;
    expect(appt).toMatchObject({ status: 'confirmed', client: { firstName: 'Bea' } });
    list = (await http().get(`/api/waitlist?branchId=${branch.id}`).auth(owner.token, bearer).expect(200)).body;
    expect(list).toHaveLength(1);
    const booked = (await http().get(`/api/waitlist?branchId=${branch.id}&status=booked`).auth(owner.token, bearer).expect(200)).body;
    expect(booked[0]).toMatchObject({ appointmentId: appt.id });
  });
});
