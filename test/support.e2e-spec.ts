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

async function outbox() {
  const { MailService } = await import('../src/core/mail/mail.service.js');
  return ctx.app.get(MailService).outbox;
}
const lastMailTo = async (email: string) => [...(await outbox())].reverse().find((m) => m.to === email);

async function login(email: string, password: string) {
  return sessionFrom(await http().post('/api/auth/login').send({ email, password }).expect(200));
}

/** Invita a un agente y le crea la contraseña con el enlace del correo. */
async function inviteAgent(admin: string, email: string, role?: 'support' | 'super_admin') {
  const invited = (await http().post('/api/platform/team').auth(admin, bearer).send({ firstName: 'Sofía', lastName: 'Ramos', email, role }).expect(201)).body;
  const token = (await lastMailTo(email))!.text.match(/\/restablecer\/([\w-]+)/)![1];
  await http().post('/api/auth/reset-password').send({ token, password: 'ClaveSoporte2026' }).expect(204);
  return { id: invited.id as string, session: await login(email, 'ClaveSoporte2026') };
}

describe('Equipo de plataforma', () => {
  it('el super admin invita a un agente de soporte, que entra con acceso limitado', async () => {
    const admin = (await login(SUPERADMIN.email, SUPERADMIN.password)).token;
    const owner = await registerBusiness(ctx.app);
    const orgId = owner.body.context.organizationId as string;

    // Un correo que ya es cuenta de negocio no se convierte en agente.
    expect((await http().post('/api/platform/team').auth(admin, bearer).send({ firstName: 'A', lastName: 'B', email: owner.email }).expect(409)).body.code).toBe('EMAIL_TAKEN');

    const invited = (await http().post('/api/platform/team').auth(admin, bearer).send({ firstName: 'Sofía', lastName: 'Ramos', email: 'Sofia@Unify.test' }).expect(201)).body;
    expect(invited).toMatchObject({ emailSent: true, inviteUrl: expect.stringContaining('/restablecer/') });
    const mail = await lastMailTo('sofia@unify.test');
    expect(mail!.subject).toContain('equipo de uBook');

    // Hasta crear su contraseña figura como pendiente y no puede entrar.
    const team = (await http().get('/api/platform/team').auth(admin, bearer).expect(200)).body;
    expect(team.find((u: { id: string }) => u.id === invited.id)).toMatchObject({ platformRole: 'support', pending: true, isActive: true });
    await http().post('/api/auth/login').send({ email: 'sofia@unify.test', password: 'ClaveSoporte2026' }).expect(401);

    // Reenviar invalida el enlace anterior.
    const oldToken = mail!.text.match(/\/restablecer\/([\w-]+)/)![1];
    await http().post(`/api/platform/team/${invited.id}/resend`).auth(admin, bearer).expect(200);
    await http().post('/api/auth/reset-password').send({ token: oldToken, password: 'ClaveSoporte2026' }).expect(400);
    const token = (await lastMailTo('sofia@unify.test'))!.text.match(/\/restablecer\/([\w-]+)/)![1];
    await http().post('/api/auth/reset-password').send({ token, password: 'ClaveSoporte2026' }).expect(204);

    const agent = await login('sofia@unify.test', 'ClaveSoporte2026');
    expect(agent.body.context.ctx).toBe('platform');
    expect((await http().get('/api/auth/me').auth(agent.token, bearer).expect(200)).body.user.platformRole).toBe('support');

    // Soporte consulta, pero no administra la plataforma.
    await http().get('/api/platform/organizations').auth(agent.token, bearer).expect(200);
    await http().get(`/api/platform/organizations/${orgId}`).auth(agent.token, bearer).expect(200);
    await http().get('/api/platform/support/tickets').auth(agent.token, bearer).expect(200);
    await http().patch(`/api/platform/organizations/${orgId}/status`).auth(agent.token, bearer).send({ status: 'suspended' }).expect(403);
    await http().patch(`/api/platform/organizations/${orgId}/subscription`).auth(agent.token, bearer).send({ planCode: 'business' }).expect(403);
    await http().get('/api/platform/team').auth(agent.token, bearer).expect(403);
    await http().post('/api/platform/team').auth(agent.token, bearer).send({ firstName: 'X', lastName: 'Y', email: 'x@unify.test' }).expect(403);
    // Y un negocio no llega al panel de plataforma.
    await http().get('/api/platform/support/tickets').auth(owner.token, bearer).expect(403);
    await http().get('/api/platform/team').auth(owner.token, bearer).expect(403);

    // Ya creó su contraseña: no se puede "cancelar la invitación", solo desactivar.
    expect((await http().delete(`/api/platform/team/${invited.id}`).auth(admin, bearer).expect(409)).body.code).toBe('ALREADY_ACTIVE');
    await http().patch(`/api/platform/team/${invited.id}`).auth(admin, bearer).send({ isActive: false }).expect(200);
    // El acceso se corta al instante, incluso con el token que ya tenía.
    await http().get('/api/platform/support/tickets').auth(agent.token, bearer).expect(401);
    await http().post('/api/auth/refresh').set('Cookie', agent.cookie).expect(401);
    await http().post('/api/auth/login').send({ email: 'sofia@unify.test', password: 'ClaveSoporte2026' }).expect(401);

    // Siempre queda un super admin.
    const me = (await http().get('/api/auth/me').auth(admin, bearer).expect(200)).body.user.id as string;
    expect((await http().patch(`/api/platform/team/${me}`).auth(admin, bearer).send({ role: 'support' }).expect(400)).body.code).toBe('CANNOT_DEMOTE_SELF');

    // Una invitación sin aceptar sí se puede cancelar.
    const pending = (await http().post('/api/platform/team').auth(admin, bearer).send({ firstName: 'Luis', lastName: 'Paz', email: 'luis@unify.test' }).expect(201)).body;
    await http().delete(`/api/platform/team/${pending.id}`).auth(admin, bearer).expect(204);
    expect((await http().get('/api/platform/team').auth(admin, bearer).expect(200)).body.some((u: { id: string }) => u.id === pending.id)).toBe(false);
  });
});

describe('Tickets de soporte', () => {
  it('el negocio abre un ticket, soporte lo atiende y se resuelve', async () => {
    const admin = (await login(SUPERADMIN.email, SUPERADMIN.password)).token;
    const { id: agentId, session: agent } = await inviteAgent(admin, 'agente1@unify.test');
    const owner = await registerBusiness(ctx.app, { name: 'Clínica Sol' });
    const orgId = owner.body.context.organizationId as string;
    const reception = await sessionAsMember(ctx.app, orgId, 'receptionist');
    const stranger = await registerBusiness(ctx.app);

    // Recepción reporta con una captura; la captura debe ser del propio negocio.
    const shot = (await http().post('/api/support/attachments').auth(reception.token, bearer).attach('file', PNG, 'error.png').expect(201)).body.key as string;
    const body = { subject: 'No puedo crear citas', category: 'bug', body: 'Al guardar la cita sale un error rojo y no se crea.', context: { path: '/agenda/nueva', viewport: '1280x720' } };
    expect((await http().post('/api/support/tickets').auth(reception.token, bearer).send({ ...body, attachments: ['support/otro/x.png'] }).expect(400)).body.code).toBe('INVALID_ATTACHMENT');
    const ticket = (await http().post('/api/support/tickets').auth(reception.token, bearer).send({ ...body, attachments: [shot] }).expect(201)).body;
    expect(ticket).toMatchObject({ number: expect.any(Number), status: 'open', assignedTo: null, unread: false });
    expect(ticket.messages).toHaveLength(1);
    expect(ticket.messages[0].attachments).toHaveLength(1);
    await http().get(ticket.messages[0].attachments[0]).expect(200);

    // El equipo de plataforma recibe el aviso.
    expect((await lastMailTo('agente1@unify.test'))!.subject).toBe(`[Ticket #${ticket.number}] No puedo crear citas`);

    // Cada quien ve lo suyo: el dueño todo el negocio, otro miembro solo sus tickets, otro negocio nada.
    const pro = await sessionAsMember(ctx.app, orgId, 'professional');
    expect((await http().get('/api/support/tickets').auth(owner.token, bearer).expect(200)).body).toMatchObject({ canSeeAll: true, items: [{ id: ticket.id }] });
    expect((await http().get('/api/support/tickets').auth(pro.token, bearer).expect(200)).body).toMatchObject({ canSeeAll: false, items: [] });
    await http().get(`/api/support/tickets/${ticket.id}`).auth(pro.token, bearer).expect(404);
    await http().get(`/api/support/tickets/${ticket.id}`).auth(stranger.token, bearer).expect(404);

    // Bandeja de soporte.
    expect((await http().get('/api/platform/support/summary').auth(agent.token, bearer).expect(200)).body).toMatchObject({ open: 1, unassigned: 1, mine: 0, unread: 1 });
    const inbox = (await http().get('/api/platform/support/tickets?status=active&assignee=none').auth(agent.token, bearer).expect(200)).body;
    expect(inbox.items[0]).toMatchObject({ id: ticket.id, organization: { name: 'Clínica Sol' }, priority: 'normal', unread: true });
    expect((await http().get(`/api/platform/support/tickets?search=%23${ticket.number}`).auth(agent.token, bearer).expect(200)).body.total).toBe(1);

    const opened = (await http().get(`/api/platform/support/tickets/${ticket.id}`).auth(agent.token, bearer).expect(200)).body;
    expect(opened).toMatchObject({ context: { path: '/agenda/nueva' }, subscription: { planCode: 'pro' }, createdBy: { email: expect.any(String) } });
    expect((await http().get('/api/platform/support/summary').auth(agent.token, bearer).expect(200)).body.unread).toBe(0);

    // Nota interna: el negocio no la ve ni cambia el estado.
    await http().post(`/api/platform/support/tickets/${ticket.id}/messages`).auth(agent.token, bearer).send({ body: 'Parece el bug de recursos', internal: true }).expect(201);
    const afterNote = (await http().get(`/api/support/tickets/${ticket.id}`).auth(reception.token, bearer).expect(200)).body;
    expect(afterNote).toMatchObject({ status: 'open', unread: false });
    expect(afterNote.messages).toHaveLength(1);

    // Respuesta pública: se asigna a quien responde, pasa a "esperando al negocio" y avisa por correo.
    const agentShot = (await http().post(`/api/platform/support/tickets/${ticket.id}/attachments`).auth(agent.token, bearer).attach('file', PNG, 'paso.png').expect(201)).body.key;
    const replied = (await http().post(`/api/platform/support/tickets/${ticket.id}/messages`).auth(agent.token, bearer).send({ body: '¿Qué servicio estabas agendando?', attachments: [agentShot] }).expect(201)).body;
    expect(replied).toMatchObject({ status: 'waiting_customer', assignedTo: { userId: agentId } });
    expect(replied.messages).toHaveLength(3);
    expect(replied.messages[1].internal).toBe(true);
    expect((await http().get('/api/support/tickets/unread').auth(reception.token, bearer).expect(200)).body.unread).toBe(1);
    expect((await http().get('/api/support/tickets/unread').auth(pro.token, bearer).expect(200)).body.unread).toBe(0);

    // El negocio lo abre (queda leído), ve el nombre de quien atiende y responde.
    const seen = (await http().get(`/api/support/tickets/${ticket.id}`).auth(reception.token, bearer).expect(200)).body;
    expect(seen).toMatchObject({ assignedTo: 'Sofía', unread: false });
    expect(seen.messages.map((m: { from: string }) => m.from)).toEqual(['customer', 'agent']);
    await http().post(`/api/support/tickets/${ticket.id}/messages`).auth(reception.token, bearer).send({ body: 'Corte de cabello', internal: true }).expect(201);
    const back = (await http().get(`/api/platform/support/tickets/${ticket.id}`).auth(agent.token, bearer).expect(200)).body;
    expect(back.status).toBe('open');
    expect(back.messages.at(-1)).toMatchObject({ from: 'customer', internal: false });

    // Prioridad, reasignación y cierre.
    await http().patch(`/api/platform/support/tickets/${ticket.id}`).auth(agent.token, bearer).send({ assignedToUserId: orgId }).expect(400);
    const done = (await http().patch(`/api/platform/support/tickets/${ticket.id}`).auth(agent.token, bearer).send({ priority: 'high', status: 'resolved' }).expect(200)).body;
    expect(done).toMatchObject({ priority: 'high', status: 'resolved', resolvedAt: expect.any(String) });
    expect((await http().get('/api/platform/support/tickets?status=active').auth(agent.token, bearer).expect(200)).body.total).toBe(0);

    // Si el negocio vuelve a escribir, se reabre; y puede cerrarlo él mismo.
    expect((await http().post(`/api/support/tickets/${ticket.id}/messages`).auth(owner.token, bearer).send({ body: 'Volvió a pasar' }).expect(201)).body.status).toBe('open');
    expect((await http().post(`/api/support/tickets/${ticket.id}/resolve`).auth(owner.token, bearer).expect(200)).body.status).toBe('resolved');
  });

  it('un negocio vencido o suspendido igual puede escribir a soporte', async () => {
    const admin = (await login(SUPERADMIN.email, SUPERADMIN.password)).token;
    const owner = await registerBusiness(ctx.app);
    const orgId = owner.body.context.organizationId as string;
    await http().patch(`/api/platform/organizations/${orgId}/subscription`).auth(admin, bearer).send({ trialEndsAt: new Date(Date.now() - 60_000).toISOString() }).expect(200);
    await http().post('/api/clients').auth(owner.token, bearer).send({ firstName: 'X' }).expect(402);

    const body = { subject: 'Ya pagué y sigo bloqueado', category: 'billing', body: 'Hice el Yape ayer y mi cuenta sigue vencida.' };
    const ticket = (await http().post('/api/support/tickets').auth(owner.token, bearer).send(body).expect(201)).body;
    await http().patch(`/api/platform/organizations/${orgId}/status`).auth(admin, bearer).send({ status: 'suspended' }).expect(200);
    await http().post(`/api/support/tickets/${ticket.id}/messages`).auth(owner.token, bearer).send({ body: '¿Alguna novedad?' }).expect(201);
  });
});

describe('Vista de soporte (ver como el negocio)', () => {
  it('el agente entra en solo lectura, sin fichas clínicas, y queda auditado', async () => {
    const admin = (await login(SUPERADMIN.email, SUPERADMIN.password)).token;
    const { session: agent } = await inviteAgent(admin, 'agente2@unify.test');
    const owner = await registerBusiness(ctx.app, { name: 'Spa Vista' });
    const orgId = owner.body.context.organizationId as string;
    const other = await registerBusiness(ctx.app);
    const client = (await http().post('/api/clients').auth(owner.token, bearer).send({ firstName: 'Paciente' }).expect(201)).body;
    const ticket = (await http().post('/api/support/tickets').auth(owner.token, bearer).send({ subject: 'No veo mis clientes', category: 'bug', body: 'La lista de clientes aparece vacía.' }).expect(201)).body;

    // Solo el equipo de plataforma puede abrir la vista.
    await http().post(`/api/platform/support/organizations/${orgId}/view`).auth(owner.token, bearer).send({}).expect(403);
    const view = (await http().post(`/api/platform/support/organizations/${orgId}/view`).auth(agent.token, bearer).send({ ticketId: ticket.id }).expect(200)).body;
    expect(view).toMatchObject({ accessToken: expect.any(String), context: { ctx: 'staff', organizationId: orgId, supportView: true } });
    const token = view.accessToken as string;

    const me = (await http().get('/api/auth/me').auth(token, bearer).expect(200)).body;
    expect(me).toMatchObject({ context: { ctx: 'staff', organizationId: orgId, supportView: true }, organization: { name: 'Spa Vista' }, user: { platformRole: 'support' } });
    expect(me.access.permissions['client.read']).toBe('organization');
    expect(me.access.permissions['client_record.read']).toBeUndefined();

    // Lee los datos del negocio (y solo de ese negocio).
    const clients = (await http().get('/api/clients').auth(token, bearer).expect(200)).body;
    expect(JSON.stringify(clients)).toContain(client.id);
    await http().get('/api/organization').auth(token, bearer).expect(200);
    expect((await http().get('/api/support/tickets').auth(token, bearer).expect(200)).body.items).toHaveLength(1);
    expect(JSON.stringify((await http().get('/api/clients').auth(other.token, bearer).expect(200)).body)).not.toContain(client.id);

    // No modifica nada.
    expect((await http().post('/api/clients').auth(token, bearer).send({ firstName: 'Intruso' }).expect(403)).body.code).toBe('SUPPORT_VIEW_READ_ONLY');
    await http().patch(`/api/clients/${client.id}`).auth(token, bearer).send({ firstName: 'Otro' }).expect(403);
    await http().post('/api/support/tickets').auth(token, bearer).send({ subject: 'Falso ticket', category: 'bug', body: 'No debería poder crearlo.' }).expect(403);
    // Ver el ticket desde la vista no lo marca como leído por el negocio.
    await http().post(`/api/platform/support/tickets/${ticket.id}/messages`).auth(agent.token, bearer).send({ body: 'Lo estoy revisando' }).expect(201);
    await http().get(`/api/support/tickets/${ticket.id}`).auth(token, bearer).expect(200);
    expect((await http().get('/api/support/tickets/unread').auth(owner.token, bearer).expect(200)).body.unread).toBe(1);

    // Las fichas clínicas quedan fuera, y el token no sirve en el panel de plataforma.
    await http().get(`/api/clients/${client.id}/records`).auth(token, bearer).expect(403);
    await http().get('/api/record-templates').auth(token, bearer).expect(403);
    await http().get('/api/platform/organizations').auth(token, bearer).expect(403);

    // Funciona también con el negocio suspendido (es cuando más se necesita mirar).
    await http().patch(`/api/platform/organizations/${orgId}/status`).auth(admin, bearer).send({ status: 'suspended' }).expect(200);
    await http().get('/api/clients').auth(token, bearer).expect(200);

    // El acceso queda registrado en la auditoría del negocio.
    const { getModelToken } = await import('@nestjs/mongoose');
    const { AuditLog } = await import('../src/core/audit/audit-log.schema.js');
    const logs = ctx.app.get(getModelToken(AuditLog.name));
    const entry = await logs.findOne({ action: 'support.view_started', organizationId: orgId }).lean().exec();
    expect(entry.metadata).toMatchObject({ ticketId: ticket.id, platformRole: 'support' });

    // Si al agente le quitan el acceso, la vista deja de funcionar al instante.
    const team = (await http().get('/api/platform/team').auth(admin, bearer).expect(200)).body;
    const agentId = team.find((u: { email: string }) => u.email === 'agente2@unify.test').id;
    await http().patch(`/api/platform/team/${agentId}`).auth(admin, bearer).send({ isActive: false }).expect(200);
    await http().get('/api/clients').auth(token, bearer).expect(401);
  });
});
