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

async function whatsappOutbox() {
  const { WhatsAppService } = await import('../src/core/mail/whatsapp.service.js');
  return ctx.app.get(WhatsAppService).outbox;
}
const lastMessageTo = async (phone: string) => [...(await whatsappOutbox())].reverse().find((m) => m.to === phone);
const lastCodeFor = async (phone: string) => (await lastMessageTo(phone))?.text.match(/\b(\d{6})\b/)?.[1];

const slugOf = async (token: string) => (await http().get('/api/organization').auth(token, bearer).expect(200)).body.slug as string;
const portal = (slug: string) => `/api/public/businesses/${slug}/portal`;
const withSession = (req: request.Test, token: string) => req.set('x-portal-token', token);

async function signIn(slug: string, phone: string) {
  await http().post(`${portal(slug)}/code`).send({ phone }).expect(200);
  const code = await lastCodeFor(`+51${phone}`);
  return (await http().post(`${portal(slug)}/session`).send({ phone, code }).expect(200)).body;
}

/** Un lunes al menos una semana en el futuro (fecha local de Lima). */
function nextMonday(): string {
  const d = new Date(Date.now() - 5 * 3_600_000 + 7 * 86_400_000);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const at = (date: string, hh: number, mm = 0) => new Date(Date.parse(`${date}T00:00:00Z`) + (h(hh, mm) + 300) * 60_000).toISOString();

/** Negocio con un servicio y un profesional que atiende los lunes por la mañana. */
async function bookableBusiness(name: string) {
  const owner = await registerBusiness(ctx.app, { name });
  const slug = await slugOf(owner.token);
  const [branch] = (await http().get('/api/branches').auth(owner.token, bearer)).body;
  const service = (await http().post('/api/services').auth(owner.token, bearer).send({ name: 'Consulta', durationMinutes: 30, price: 5000 }).expect(201)).body;
  const pro = (await http().post('/api/professionals').auth(owner.token, bearer).send({ displayName: 'Dra. Paz', branchIds: [branch.id], services: [{ serviceId: service.id }] }).expect(201)).body;
  await http()
    .put(`/api/professionals/${pro.id}/schedule`)
    .auth(owner.token, bearer)
    .send({ branchId: branch.id, days: [{ weekday: 1, intervals: [{ start: h(9), end: h(13) }] }] })
    .expect(200);
  return { owner, slug, branchId: branch.id as string, serviceId: service.id as string, professionalId: pro.id as string, date: nextMonday() };
}

describe('Portal del cliente: entrar', () => {
  it('el cliente entra con su celular y un código por WhatsApp, solo en ese negocio', async () => {
    const barber = await registerBusiness(ctx.app, { name: 'Barbería Portal' });
    const podo = await registerBusiness(ctx.app, { name: 'Podología Portal' });
    const [barberSlug, podoSlug] = [await slugOf(barber.token), await slugOf(podo.token)];
    expect((await http().get(`/api/public/businesses/${barberSlug}`).expect(200)).body.portal).toBe(true);

    // La misma persona es cliente de los dos negocios; en la barbería comparte celular con su hijo.
    const ana = (await http().post('/api/clients').auth(barber.token, bearer).send({ firstName: 'Ana', lastName: 'Ríos', phone: '987111222' }).expect(201)).body;
    await http().post('/api/clients').auth(barber.token, bearer).send({ firstName: 'Mateo', lastName: 'Ríos', phone: '987111222', allowSharedPhone: true }).expect(201);
    await http().post('/api/clients').auth(podo.token, bearer).send({ firstName: 'Ana', lastName: 'Ríos', phone: '987111222' }).expect(201);

    // Pedir código responde igual para un celular desconocido, pero no envía nada.
    const before = (await whatsappOutbox()).length;
    expect((await http().post(`${portal(barberSlug)}/code`).send({ phone: '900000000' }).expect(200)).body.ok).toBe(true);
    expect((await whatsappOutbox()).length).toBe(before);
    await http().post(`${portal(barberSlug)}/code`).send({ phone: '12345' }).expect(400);

    await http().post(`${portal(barberSlug)}/code`).send({ phone: '987 111 222' }).expect(200);
    expect((await lastMessageTo('+51987111222'))!.text).toContain('Barbería Portal');
    const code = (await lastCodeFor('+51987111222'))!;

    // Código equivocado, código de otro negocio y reutilización: nada entra.
    const wrong = code === '000000' ? '000001' : '000000';
    expect((await http().post(`${portal(barberSlug)}/session`).send({ phone: '987111222', code: wrong }).expect(400)).body.code).toBe('INVALID_CODE');
    await http().post(`${portal(podoSlug)}/session`).send({ phone: '987111222', code }).expect(400);
    const session = (await http().post(`${portal(barberSlug)}/session`).send({ phone: '987111222', code }).expect(200)).body;
    expect(session.profiles.map((p: { firstName: string; isHolder: boolean }) => [p.firstName, p.isHolder])).toEqual([['Ana', true], ['Mateo', true]]);
    expect(session.features).toEqual({ guardians: true });
    await http().post(`${portal(barberSlug)}/session`).send({ phone: '987111222', code }).expect(400);

    // La sesión vale solo en la barbería.
    const token = session.token as string;
    const me = (await withSession(http().get(`${portal(barberSlug)}/me`), token).expect(200)).body;
    expect(me).toMatchObject({ phone: '+51987111222' });
    expect(me.profiles).toHaveLength(2);
    expect((await withSession(http().get(`${portal(podoSlug)}/me`), token).expect(401)).body.code).toBe('PORTAL_SESSION_EXPIRED');
    await http().get(`${portal(barberSlug)}/me`).expect(401);
    await withSession(http().get(`${portal(barberSlug)}/me`), `${token}x`).expect(401);
    await http().get(`${portal(barberSlug)}/appointments`).expect(401);
    await http().get(`${portal(barberSlug)}/payments`).expect(401);

    // Solo toca los perfiles de su cuenta.
    const other = (await http().post('/api/clients').auth(barber.token, bearer).send({ firstName: 'Otro', phone: '955000111' }).expect(201)).body;
    await withSession(http().patch(`${portal(barberSlug)}/profiles/${other.id}`), token).send({ firstName: 'Hackeado' }).expect(404);
    await withSession(http().delete(`${portal(barberSlug)}/dependents/${other.id}`), token).expect(404);

    // Actualiza sus datos; el negocio los ve.
    const updated = (await withSession(http().patch(`${portal(barberSlug)}/profiles/${ana.id}`), token).send({ email: 'Ana@Correo.pe', birthDate: '1990-05-12', marketingConsent: true }).expect(200)).body;
    expect(updated).toMatchObject({ firstName: 'Ana', email: 'ana@correo.pe', birthDate: '1990-05-12', marketingConsent: true, isHolder: true });
    expect((await http().get(`/api/clients/${ana.id}`).auth(barber.token, bearer).expect(200)).body).toMatchObject({ email: 'ana@correo.pe', birthDate: '1990-05-12' });
    await withSession(http().patch(`${portal(barberSlug)}/profiles/${ana.id}`), token).send({ email: 'no-es-correo' }).expect(400);

    // En la podología entra aparte y ve solo su perfil de ahí.
    expect((await signIn(podoSlug, '987111222')).profiles).toHaveLength(1);
  });

  it('limita los códigos por celular y los intentos por código', async () => {
    const owner = await registerBusiness(ctx.app);
    const slug = await slugOf(owner.token);
    await http().post('/api/clients').auth(owner.token, bearer).send({ firstName: 'Luis', phone: '944333222' }).expect(201);

    await http().post(`${portal(slug)}/code`).send({ phone: '944333222' }).expect(200);
    const code = (await lastCodeFor('+51944333222'))!;
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i += 1) await http().post(`${portal(slug)}/session`).send({ phone: '944333222', code: wrong }).expect(400);
    // Tras 5 fallos, ni el código correcto sirve.
    await http().post(`${portal(slug)}/session`).send({ phone: '944333222', code }).expect(400);

    await http().post(`${portal(slug)}/code`).send({ phone: '944333222' }).expect(200);
    await http().post(`${portal(slug)}/code`).send({ phone: '944333222' }).expect(200);
    expect((await http().post(`${portal(slug)}/code`).send({ phone: '944333222' }).expect(429)).body.code).toBe('TOO_MANY_CODES');
  });

  it('no existe si el plan no incluye portal', async () => {
    const owner = await registerBusiness(ctx.app, { planCode: 'starter' });
    const slug = await slugOf(owner.token);
    expect((await http().get(`/api/public/businesses/${slug}`).expect(200)).body.portal).toBe(false);
    expect((await http().post(`${portal(slug)}/code`).send({ phone: '987111222' }).expect(404)).body.code).toBe('PORTAL_UNAVAILABLE');
  });
});

describe('Portal del cliente: familia, citas y pagos', () => {
  it('el titular registra a su hija, le reserva una cita y ve las citas y pagos de ambos', async () => {
    const s = await bookableBusiness('Clínica Familia');
    const carla = (await http().post('/api/clients').auth(s.owner.token, bearer).send({ firstName: 'Carla', lastName: 'Soto', phone: '933222111', email: 'carla@cliente.test' }).expect(201)).body;
    const { token } = await signIn(s.slug, '933222111');
    const api = portal(s.slug);

    // Registra a su hija (sin celular propio). El parentesco es obligatorio.
    await withSession(http().post(`${api}/dependents`), token).send({ firstName: 'Lía' }).expect(400);
    const lia = (await withSession(http().post(`${api}/dependents`), token).send({ firstName: 'Lía', lastName: 'Soto', birthDate: '2018-03-02', relationship: 'Hijo/a', documentId: '71234567' }).expect(201)).body;
    expect(lia).toMatchObject({ firstName: 'Lía', isHolder: false, guardianId: carla.id, relationship: 'Hijo/a', birthDate: '2018-03-02' });
    expect((await withSession(http().post(`${api}/dependents`), token).send({ firstName: 'Otra', relationship: 'Hijo/a', documentId: '71234567' }).expect(409)).body.code).toBe('DOCUMENT_TAKEN');
    const me = (await withSession(http().get(`${api}/me`), token).expect(200)).body;
    expect(me.profiles.map((p: { firstName: string }) => p.firstName)).toEqual(['Carla', 'Lía']);

    // El negocio ve el vínculo en la ficha de ambas.
    expect((await http().get(`/api/clients/${carla.id}/family`).auth(s.owner.token, bearer).expect(200)).body).toMatchObject({ guardian: null, dependents: [{ id: lia.id, relationship: 'Hijo/a' }] });
    expect((await http().get(`/api/clients/${lia.id}/family`).auth(s.owner.token, bearer).expect(200)).body).toMatchObject({ guardian: { id: carla.id, phone: '+51933222111', relationship: 'Hijo/a' }, dependents: [] });

    // Reserva con la sesión para su hija y para ella, sin volver a escribir datos.
    const booking = { branchId: s.branchId, serviceId: s.serviceId, acceptsTerms: true };
    await http().post(`/api/public/businesses/${s.slug}/bookings`).send({ ...booking, startsAt: at(s.date, 9), forClientId: lia.id }).expect(401);
    const forLia = (await withSession(http().post(`/api/public/businesses/${s.slug}/bookings`), token).send({ ...booking, startsAt: at(s.date, 9), forClientId: lia.id }).expect(201)).body;
    expect(forLia.booking).toMatchObject({ clientFirstName: 'Lía', status: 'confirmed' });
    await withSession(http().post(`/api/public/businesses/${s.slug}/bookings`), token).send({ ...booking, startsAt: at(s.date, 10), forClientId: carla.id }).expect(201);
    // No puede reservar a nombre de alguien que no es de su cuenta.
    const stranger = (await http().post('/api/clients').auth(s.owner.token, bearer).send({ firstName: 'Ajeno', phone: '955444333' }).expect(201)).body;
    await withSession(http().post(`/api/public/businesses/${s.slug}/bookings`), token).send({ ...booking, startsAt: at(s.date, 11), forClientId: stranger.id }).expect(404);

    // Los avisos de la cita de la hija llegan al celular de la mamá.
    await http().patch('/api/automations/confirmation').auth(s.owner.token, bearer).send({ enabled: true, channels: ['whatsapp'], message: 'Hola, la cita de {{cliente.nombre}} quedó confirmada.' }).expect(200);
    const again = (await withSession(http().post(`/api/public/businesses/${s.slug}/bookings`), token).send({ ...booking, startsAt: at(s.date, 12), forClientId: lia.id }).expect(201)).body;
    expect(again.booking.clientFirstName).toBe('Lía');
    expect((await lastMessageTo('+51933222111'))!.text).toContain('Lía');

    // Ve las citas de las dos, con quién es cada una y el enlace para gestionarla.
    const appts = (await withSession(http().get(`${api}/appointments`), token).expect(200)).body;
    expect(appts.past).toEqual([]);
    expect(appts.upcoming.map((a: { clientId: string }) => a.clientId)).toEqual([lia.id, carla.id, lia.id]);
    expect(appts.upcoming[0]).toMatchObject({ serviceName: 'Consulta', serviceId: s.serviceId, professional: { id: s.professionalId, displayName: 'Dra. Paz' }, branch: { id: s.branchId } });
    await http().get(`/api/public/bookings/${appts.upcoming[0].token}`).expect(200);

    // Mientras tenga citas próximas no se le puede quitar de la cuenta.
    expect((await withSession(http().delete(`${api}/dependents/${lia.id}`), token).expect(409)).body.code).toBe('HAS_UPCOMING_APPOINTMENTS');

    // El negocio cobra la primera cita; el portal muestra el pago.
    const all = (await http().get(`/api/clients/${lia.id}`).auth(s.owner.token, bearer).expect(200)).body;
    expect(all.guardianId).toBe(carla.id);
    expect((await withSession(http().get(`${api}/payments`), token).expect(200)).body).toEqual({ items: [], totalThisYear: 0 });

    // Cambia el parentesco; tras cancelar sus citas, la quita. Como tuvo citas, el negocio conserva su ficha.
    expect((await withSession(http().patch(`${api}/profiles/${lia.id}`), token).send({ relationship: 'Nieto/a' }).expect(200)).body.relationship).toBe('Nieto/a');
    await withSession(http().patch(`${api}/profiles/${carla.id}`), token).send({ relationship: 'Otro' }).expect(200);
    for (const a of appts.upcoming.filter((x: { clientId: string }) => x.clientId === lia.id)) {
      await http().post(`/api/public/bookings/${a.token}/cancel`).send({}).expect(200);
    }
    await withSession(http().delete(`${api}/dependents/${lia.id}`), token).expect(200);
    expect((await withSession(http().get(`${api}/me`), token).expect(200)).body.profiles).toHaveLength(1);
    expect((await http().get(`/api/clients/${lia.id}`).auth(s.owner.token, bearer).expect(200)).body.guardianId).toBeNull();

    // Una persona sin citas se borra del todo; al titular no se le puede quitar.
    const tmp = (await withSession(http().post(`${api}/dependents`), token).send({ firstName: 'Temporal', relationship: 'Otro' }).expect(201)).body;
    await withSession(http().delete(`${api}/dependents/${tmp.id}`), token).expect(200);
    await http().get(`/api/clients/${tmp.id}`).auth(s.owner.token, bearer).expect(404);
    await withSession(http().delete(`${api}/dependents/${carla.id}`), token).expect(404);
  });

  it('el negocio vincula y desvincula beneficiarios desde la ficha del cliente', async () => {
    const owner = await registerBusiness(ctx.app);
    const slug = await slugOf(owner.token);
    const post = (path: string, body: Record<string, unknown>) => http().post(`/api/clients${path}`).auth(owner.token, bearer).send(body);
    const papa = (await post('', { firstName: 'Jorge', lastName: 'Vega', phone: '922111000' }).expect(201)).body;
    const hijo = (await post('', { firstName: 'Tomás', lastName: 'Vega' }).expect(201)).body;

    // Vincula un cliente que ya existía y crea otro nuevo a su cargo.
    const family = (await post(`/${papa.id}/dependents`, { clientId: hijo.id, relationship: 'Hijo/a' }).expect(201)).body;
    expect(family.dependents).toEqual([expect.objectContaining({ id: hijo.id, relationship: 'Hijo/a' })]);
    expect((await post(`/${papa.id}/dependents`, { firstName: 'Rosa', lastName: 'Vega', relationship: 'Padre/Madre' }).expect(201)).body.dependents).toHaveLength(2);

    // Un solo nivel: ni responsable de sí mismo, ni cadenas.
    expect((await post(`/${papa.id}/dependents`, { clientId: papa.id }).expect(400)).body.code).toBe('SAME_CLIENT');
    expect((await post(`/${hijo.id}/dependents`, { firstName: 'Nieto' }).expect(400)).body.code).toBe('GUARDIAN_IS_DEPENDENT');
    const otro = (await post('', { firstName: 'Otro', phone: '922111999' }).expect(201)).body;
    expect((await post(`/${otro.id}/dependents`, { clientId: hijo.id }).expect(409)).body.code).toBe('ALREADY_HAS_GUARDIAN');
    expect((await post(`/${otro.id}/dependents`, { clientId: papa.id }).expect(400)).body.code).toBe('DEPENDENT_IS_GUARDIAN');

    // El papá los ve en su portal aunque no compartan celular.
    const session = await signIn(slug, '922111000');
    expect(session.profiles.map((p: { firstName: string; isHolder: boolean }) => [p.firstName, p.isHolder])).toEqual([['Jorge', true], ['Tomás', false], ['Rosa', false]]);

    // Cambiar parentesco y quitar el vínculo.
    expect((await http().patch(`/api/clients/${hijo.id}/guardian`).auth(owner.token, bearer).send({ relationship: 'Otro' }).expect(200)).body.guardian.relationship).toBe('Otro');
    expect((await http().delete(`/api/clients/${hijo.id}/guardian`).auth(owner.token, bearer).expect(200)).body.guardian).toBeNull();
    expect((await withSession(http().get(`${portal(slug)}/me`), session.token).expect(200)).body.profiles).toHaveLength(2);
    await http().delete(`/api/clients/${hijo.id}/guardian`).auth(owner.token, bearer).expect(400);
  });

  it('sin la funcionalidad de responsables no se registran personas a cargo', async () => {
    const owner = await registerBusiness(ctx.app);
    const slug = await slugOf(owner.token);
    const orgId = owner.body.context.organizationId as string;
    const admin = (await http().post('/api/auth/login').send({ email: 'root@ubook.test', password: 'SuperSecret123!' }).expect(200)).body.accessToken as string;
    await http().patch(`/api/platform/organizations/${orgId}/subscription`).auth(admin, bearer).send({ overrides: { guardians: false } }).expect(200);

    const cliente = (await http().post('/api/clients').auth(owner.token, bearer).send({ firstName: 'Eva', phone: '911000222' }).expect(201)).body;
    const session = await signIn(slug, '911000222');
    expect(session.features).toEqual({ guardians: false });
    expect((await withSession(http().post(`${portal(slug)}/dependents`), session.token).send({ firstName: 'Hijo', relationship: 'Hijo/a' }).expect(403)).body.code).toBe('FEATURE_NOT_IN_PLAN');
    expect((await http().post(`/api/clients/${cliente.id}/dependents`).auth(owner.token, bearer).send({ firstName: 'Hijo' }).expect(403)).body.code).toBe('FEATURE_NOT_IN_PLAN');
  });
});
