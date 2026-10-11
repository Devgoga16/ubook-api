import request from 'supertest';
import { closeTestApp, createTestApp, registerBusiness, sessionAsMember, sessionFrom, SUPERADMIN, type TestContext } from './helpers.js';

let ctx: TestContext;
const http = () => request(ctx.app.getHttpServer());
const bearer = { type: 'bearer' as const };

beforeAll(async () => {
  ctx = await createTestApp();
}, 180_000);

afterAll(async () => {
  await closeTestApp(ctx);
});

/** PNG mínimo: basta la firma para que se reconozca como imagen. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

async function whatsappOutbox() {
  const { WhatsAppService } = await import('../src/core/mail/whatsapp.service.js');
  return ctx.app.get(WhatsAppService).outbox;
}
const lastMessageTo = async (phone: string) => [...(await whatsappOutbox())].reverse().find((m) => m.to === phone);

const slugOf = async (token: string) => (await http().get('/api/organization').auth(token, bearer).expect(200)).body.slug as string;
const portal = (slug: string) => `/api/public/businesses/${slug}/portal`;
const withSession = (req: request.Test, token: string) => req.set('x-portal-token', token);

async function signIn(slug: string, phone: string): Promise<string> {
  await http().post(`${portal(slug)}/code`).send({ phone }).expect(200);
  const code = (await lastMessageTo(`+51${phone}`))!.text.match(/\b(\d{6})\b/)![1];
  return (await http().post(`${portal(slug)}/session`).send({ phone, code }).expect(200)).body.token as string;
}

describe('Portal del cliente: ayuda', () => {
  it('una consulta sobre su cita la atiende el negocio; un problema técnico, el soporte de uBook', async () => {
    const owner = await registerBusiness(ctx.app, { name: 'Spa Ayuda' });
    const orgId = owner.body.context.organizationId as string;
    const slug = await slugOf(owner.token);
    const other = await registerBusiness(ctx.app);
    const platform = sessionFrom(await http().post('/api/auth/login').send(SUPERADMIN).expect(200)).token;
    await http().post('/api/clients').auth(owner.token, bearer).send({ firstName: 'Rosa', lastName: 'Luna', phone: '977888111' }).expect(201);
    await http().post('/api/clients').auth(owner.token, bearer).send({ firstName: 'Otra', phone: '977888222' }).expect(201);
    const rosa = await signIn(slug, '977888111');
    const otra = await signIn(slug, '977888222');
    const api = portal(slug);

    // Sin sesión no hay ayuda; el tema es obligatorio.
    await http().get(`${api}/help`).expect(401);
    await withSession(http().post(`${api}/help`), rosa).send({ subject: 'Hola hola', body: 'Sin tema elegido' }).expect(400);

    /* ----- Consulta al negocio ----- */
    const shot = (await withSession(http().post(`${api}/help/attachments`), rosa).attach('file', PNG, 'captura.png').expect(201)).body.key as string;
    const inquiry = (
      await withSession(http().post(`${api}/help`), rosa).send({ topic: 'appointment', subject: '¿Puedo llegar 10 minutos tarde?', body: 'Mañana salgo tarde del trabajo.', attachments: [shot] }).expect(201)
    ).body;
    expect(inquiry).toMatchObject({ audience: 'business', category: 'appointment', status: 'open', unread: false });
    expect(inquiry.messages).toHaveLength(1);
    expect(inquiry.messages[0]).toMatchObject({ from: 'customer', authorName: 'Rosa Luna' });
    await http().get(inquiry.messages[0].attachments[0]).expect(200);

    // Solo la ve su dueña.
    expect((await withSession(http().get(`${api}/help`), rosa).expect(200)).body).toMatchObject({ unread: 0, items: [{ id: inquiry.id }] });
    expect((await withSession(http().get(`${api}/help`), otra).expect(200)).body.items).toEqual([]);
    await withSession(http().get(`${api}/help/${inquiry.id}`), otra).expect(404);

    // Llega a la bandeja del negocio (y a la campana), no a la de plataforma ni a los tickets del negocio con uBook.
    expect((await http().get('/api/support/inquiries/unread').auth(owner.token, bearer).expect(200)).body.unread).toBe(1);
    const inbox = (await http().get('/api/support/inquiries?status=active').auth(owner.token, bearer).expect(200)).body;
    expect(inbox).toEqual([expect.objectContaining({ id: inquiry.id, unread: true, client: expect.objectContaining({ name: 'Rosa Luna', phone: '+51977888111' }) })]);
    expect((await http().get('/api/notifications').auth(owner.token, bearer).expect(200)).body.items[0]).toMatchObject({ type: 'client_inquiry', title: 'Consulta de un cliente' });
    expect((await http().get('/api/support/tickets').auth(owner.token, bearer).expect(200)).body.items).toEqual([]);
    expect((await http().get('/api/platform/support/tickets').auth(platform, bearer).expect(200)).body.items.some((t: { id: string }) => t.id === inquiry.id)).toBe(false);
    await http().get(`/api/platform/support/tickets/${inquiry.id}`).auth(platform, bearer).expect(404);
    await http().get(`/api/support/inquiries/${inquiry.id}`).auth(other.token, bearer).expect(404);
    // Un profesional (solo sus clientes) sí puede leer consultas; quien no ve clientes, no.
    const reception = await sessionAsMember(ctx.app, orgId, 'receptionist');
    await http().get('/api/support/inquiries').auth(reception.token, bearer).expect(200);

    // El negocio deja una nota interna y responde: el cliente recibe un WhatsApp con el enlace a su portal.
    await http().post(`/api/support/inquiries/${inquiry.id}/messages`).auth(owner.token, bearer).send({ body: 'Avisar a Ana', internal: true }).expect(201);
    const answered = (await http().post(`/api/support/inquiries/${inquiry.id}/messages`).auth(owner.token, bearer).send({ body: 'Claro, te esperamos hasta 15 minutos.' }).expect(201)).body;
    expect(answered).toMatchObject({ status: 'waiting_customer', unread: false });
    expect(answered.messages).toHaveLength(3);
    const notice = (await lastMessageTo('+51977888111'))!.text;
    expect(notice).toContain('Spa Ayuda respondió tu consulta');
    expect(notice).toContain(`/reservar/${slug}/mi-cuenta?tab=ayuda&c=${inquiry.id}`);

    // La clienta ve la respuesta (no la nota), queda leída, responde y la cierra.
    expect((await withSession(http().get(`${api}/help`), rosa).expect(200)).body.unread).toBe(1);
    const seen = (await withSession(http().get(`${api}/help/${inquiry.id}`), rosa).expect(200)).body;
    expect(seen.messages.map((m: { from: string }) => m.from)).toEqual(['customer', 'agent']);
    expect((await withSession(http().get(`${api}/help`), rosa).expect(200)).body.unread).toBe(0);
    await withSession(http().post(`${api}/help/${inquiry.id}/messages`), rosa).send({ body: '¡Gracias!', internal: true }).expect(201);
    const back = (await http().get(`/api/support/inquiries/${inquiry.id}`).auth(owner.token, bearer).expect(200)).body;
    expect(back.status).toBe('open');
    expect(back.messages.at(-1)).toMatchObject({ from: 'customer', internal: false });
    expect((await http().patch(`/api/support/inquiries/${inquiry.id}`).auth(owner.token, bearer).send({ status: 'resolved' }).expect(200)).body.status).toBe('resolved');
    expect((await http().get('/api/support/inquiries?status=active').auth(owner.token, bearer).expect(200)).body).toEqual([]);
    expect((await withSession(http().post(`${api}/help/${inquiry.id}/messages`), rosa).send({ body: 'Una cosa más' }).expect(201)).body.status).toBe('open');
    expect((await withSession(http().post(`${api}/help/${inquiry.id}/resolve`), rosa).expect(200)).body.status).toBe('resolved');

    /* ----- Problema técnico: al soporte de uBook ----- */
    const bug = (
      await withSession(http().post(`${api}/help`), rosa).send({ topic: 'technical', subject: 'No carga el calendario', body: 'Se queda en blanco al elegir la hora.', context: { path: `/reservar/${slug}`, viewport: '390x844' } }).expect(201)
    ).body;
    expect(bug).toMatchObject({ audience: 'platform', category: 'bug' });

    // No aparece en la bandeja del negocio; sí en la de plataforma, marcado como de un cliente final.
    expect((await http().get('/api/support/inquiries').auth(owner.token, bearer).expect(200)).body.some((t: { id: string }) => t.id === bug.id)).toBe(false);
    await http().get(`/api/support/inquiries/${bug.id}`).auth(owner.token, bearer).expect(404);
    await http().get(`/api/support/tickets/${bug.id}`).auth(owner.token, bearer).expect(404);
    const ticket = (await http().get(`/api/platform/support/tickets/${bug.id}`).auth(platform, bearer).expect(200)).body;
    expect(ticket).toMatchObject({ fromClient: true, organization: { name: 'Spa Ayuda' }, createdBy: { userId: null, name: 'Rosa Luna', phone: '+51977888111' }, context: { viewport: '390x844' } });

    // Soporte responde: la clienta recibe el aviso y ve la respuesta en su portal.
    await http().post(`/api/platform/support/tickets/${bug.id}/messages`).auth(platform, bearer).send({ body: 'Ya lo corregimos, prueba de nuevo.' }).expect(201);
    expect((await lastMessageTo('+51977888111'))!.text).toContain('El soporte de uBook respondió tu consulta');
    const reply = (await withSession(http().get(`${api}/help/${bug.id}`), rosa).expect(200)).body;
    expect(reply).toMatchObject({ status: 'waiting_customer' });
    expect(reply.messages.at(-1)).toMatchObject({ from: 'agent', body: 'Ya lo corregimos, prueba de nuevo.' });
  });
});
