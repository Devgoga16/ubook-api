import request from 'supertest';
import { closeTestApp, createTestApp, registerBusiness, sessionAsMember, sessionFrom, type TestContext } from './helpers.js';

let ctx: TestContext;
const http = () => request(ctx.app.getHttpServer());
const bearer = { type: 'bearer' as const };

beforeAll(async () => {
  ctx = await createTestApp();
}, 180_000);

afterAll(async () => {
  await closeTestApp(ctx);
});

async function outbox() {
  const { MailService } = await import('../src/core/mail/mail.service.js');
  return ctx.app.get(MailService).outbox;
}

/** Token del último correo enviado a `email`. */
async function tokenFor(email: string): Promise<string> {
  const mail = [...(await outbox())].reverse().find((m) => m.to === email);
  const match = mail?.text.match(/\/invitacion\/([\w-]+)/);
  if (!match) throw new Error(`Sin invitación para ${email}`);
  return match[1]!;
}

async function setup() {
  const owner = await registerBusiness(ctx.app);
  const roles = (await http().get('/api/roles').auth(owner.token, bearer).expect(200)).body as Array<{ id: string; templateKey: string }>;
  const role = (key: string) => roles.find((r) => r.templateKey === key)!.id;
  return { owner, orgId: owner.body.context.organizationId as string, role };
}

const invite = (token: string, body: Record<string, unknown>) => http().post('/api/invitations').auth(token, bearer).send(body);

describe('Equipo: invitaciones', () => {
  it('invita por correo, la persona crea su cuenta y entra al negocio con su rol', async () => {
    const s = await setup();
    const res = await invite(s.owner.token, { email: 'Rosa@Equipo.test ', firstName: 'Rosa', roleIds: [s.role('receptionist')] }).expect(201);
    expect(res.body).toMatchObject({ email: 'rosa@equipo.test', status: 'pending', emailSent: true });
    expect(res.body.tokenHash).toBeUndefined();
    expect(res.body.inviteUrl).toMatch(/\/invitacion\/[\w-]{40,}$/);

    const mail = (await outbox()).at(-1)!;
    expect(mail).toMatchObject({ to: 'rosa@equipo.test', subject: expect.stringContaining('te invitó') });
    const token = await tokenFor('rosa@equipo.test');

    const preview = await http().get(`/api/auth/invitations/${token}`).expect(200);
    expect(preview.body).toMatchObject({ email: 'rosa@equipo.test', roleNames: ['Recepción'], accountExists: false });

    const weak = await http().post('/api/auth/accept-invitation').send({ token, password: 'corta' }).expect(400);
    expect(Object.keys(weak.body.details.fields).sort()).toEqual(['lastName', 'password']);

    const accepted = await http()
      .post('/api/auth/accept-invitation')
      .send({ token, password: 'ClaveSegura123', lastName: 'Quispe' })
      .expect(200);
    const rosa = sessionFrom(accepted);
    expect(rosa.body.context).toMatchObject({ ctx: 'staff', organizationId: s.orgId });

    const me = await http().get('/api/auth/me').auth(rosa.token, bearer).expect(200);
    expect(me.body.user).toMatchObject({ firstName: 'Rosa', lastName: 'Quispe' });
    expect(me.body.access.permissions['booking.create']).toBe('branch');
    expect(me.body.access.permissions['member.manage']).toBeUndefined();

    // El enlace ya no sirve, y ya no aparece entre pendientes.
    expect((await http().get(`/api/auth/invitations/${token}`).expect(400)).body.code).toBe('INVITATION_INVALID');
    expect((await http().get('/api/invitations').auth(s.owner.token, bearer).expect(200)).body).toHaveLength(0);

    // Ya es miembro: no se puede volver a invitar. Recepción no puede invitar.
    expect((await invite(s.owner.token, { email: 'rosa@equipo.test', firstName: 'Rosa', roleIds: [s.role('admin')] }).expect(409)).body.code).toBe(
      'ALREADY_MEMBER',
    );
    await invite(rosa.token, { email: 'otro@equipo.test', firstName: 'Otro', roleIds: [s.role('professional')] }).expect(403);
  });

  it('una cuenta existente acepta con su contraseña y queda en ambos negocios', async () => {
    const s = await setup();
    const other = await registerBusiness(ctx.app);
    await invite(s.owner.token, { email: other.email, firstName: 'Ana', roleIds: [s.role('admin')] }).expect(201);
    const token = await tokenFor(other.email);

    expect((await http().get(`/api/auth/invitations/${token}`).expect(200)).body.accountExists).toBe(true);
    await http().post('/api/auth/accept-invitation').send({ token, password: 'otra-clave-123' }).expect(401);
    const ok = await http().post('/api/auth/accept-invitation').send({ token, password: other.password }).expect(200);
    const me = await http().get('/api/auth/me').auth(sessionFrom(ok).token, bearer).expect(200);
    expect(me.body.organizations).toHaveLength(2);
  });

  it('reenviar invalida el enlace anterior; cancelar lo anula; los vencidos no sirven', async () => {
    const s = await setup();
    const first = (await invite(s.owner.token, { email: 'leo@equipo.test', firstName: 'Leo', roleIds: [s.role('professional')] }).expect(201)).body;
    const oldToken = await tokenFor('leo@equipo.test');
    await http().post(`/api/invitations/${first.id}/resend`).auth(s.owner.token, bearer).expect(200);
    const newToken = await tokenFor('leo@equipo.test');
    expect(newToken).not.toBe(oldToken);
    await http().get(`/api/auth/invitations/${oldToken}`).expect(400);
    await http().get(`/api/auth/invitations/${newToken}`).expect(200);

    await http().delete(`/api/invitations/${first.id}`).auth(s.owner.token, bearer).expect(204);
    await http().get(`/api/auth/invitations/${newToken}`).expect(400);

    // Vencida.
    await invite(s.owner.token, { email: 'vencida@equipo.test', firstName: 'V', roleIds: [s.role('professional')] }).expect(201);
    const token = await tokenFor('vencida@equipo.test');
    const { getModelToken } = await import('@nestjs/mongoose');
    const { TenantContext } = await import('../src/core/tenancy/tenant-context.js');
    const { Invitation } = await import('../src/modules/organization/schemas/invitation.schema.js');
    const model = ctx.app.get(getModelToken(Invitation.name));
    await TenantContext.runAsSystem(() => model.updateMany({ email: 'vencida@equipo.test' }, { expiresAt: new Date(Date.now() - 1000) }).exec());
    expect((await http().get(`/api/auth/invitations/${token}`).expect(400)).body.code).toBe('INVITATION_EXPIRED');
  });

  it('al aceptar se vincula al perfil de profesional indicado', async () => {
    const s = await setup();
    const [branch] = (await http().get('/api/branches').auth(s.owner.token, bearer)).body;
    const pro = (await http().post('/api/professionals').auth(s.owner.token, bearer).send({ displayName: 'Dra. Vega', branchIds: [branch.id] }).expect(201)).body;
    await invite(s.owner.token, { email: 'vega@equipo.test', firstName: 'Lucía', roleIds: [s.role('professional')], professionalId: pro.id }).expect(201);
    const ok = await http()
      .post('/api/auth/accept-invitation')
      .send({ token: await tokenFor('vega@equipo.test'), password: 'ClaveSegura123', lastName: 'Vega' })
      .expect(200);
    const list = (await http().get('/api/professionals').auth(s.owner.token, bearer).expect(200)).body;
    expect(list.find((p: { id: string }) => p.id === pro.id).membershipId).toBe(ok.body.context.membershipId);

    // Ya tiene acceso: no se puede invitar otra vez para ese profesional.
    const again = await invite(s.owner.token, { email: 'x@equipo.test', firstName: 'X', roleIds: [s.role('professional')], professionalId: pro.id });
    expect(again.status).toBe(409);
  });

  it('solo el Dueño invita Dueños; nadie se suspende a sí mismo; suspender corta el acceso', async () => {
    const s = await setup();
    const admin = await sessionAsMember(ctx.app, s.orgId, 'admin');
    await invite(admin.token, { email: 'jefe@equipo.test', firstName: 'Jefe', roleIds: [s.role('owner')] }).expect(403);
    await invite(s.owner.token, { email: 'jefe@equipo.test', firstName: 'Jefe', roleIds: [s.role('owner')] }).expect(201);

    const ownerMembership = s.owner.body.context.membershipId as string;
    const self = await http().patch(`/api/members/${ownerMembership}`).auth(s.owner.token, bearer).send({ status: 'suspended' }).expect(409);
    expect(self.body.code).toBe('SELF_SUSPEND');

    const adminMembership = admin.body.context.membershipId as string;
    await http().patch(`/api/members/${adminMembership}`).auth(s.owner.token, bearer).send({ status: 'suspended' }).expect(200);
    await http().get('/api/clients').auth(admin.token, bearer).expect(401);
  });
});

describe('Dueño que también atiende y roles combinados', () => {
  it('al registrar con "yo también atiendo" crea su perfil de profesional vinculado', async () => {
    const res = await http()
      .post('/api/auth/register')
      .send({
        firstName: 'Carmen',
        lastName: 'Salas',
        email: 'carmen@consultorio.test',
        password: 'Password1234',
        organization: { name: 'Consultorio Salas', ownerAttends: true },
      })
      .expect(201);
    const token = res.body.accessToken as string;
    const pros = (await http().get('/api/professionals').auth(token, bearer).expect(200)).body;
    expect(pros).toHaveLength(1);
    expect(pros[0]).toMatchObject({ displayName: 'Carmen Salas', membershipId: res.body.context.membershipId });
  });

  it('una persona con Recepción + Profesional tiene el permiso más amplio de cada uno', async () => {
    const s = await setup();
    await invite(s.owner.token, { email: 'doble@equipo.test', firstName: 'Rita', roleIds: [s.role('receptionist'), s.role('professional')] }).expect(201);
    const ok = await http()
      .post('/api/auth/accept-invitation')
      .send({ token: await tokenFor('doble@equipo.test'), password: 'ClaveSegura123', lastName: 'Paz' })
      .expect(200);
    const me = (await http().get('/api/auth/me').auth(sessionFrom(ok).token, bearer).expect(200)).body;
    expect(me.access.permissions).toMatchObject({ 'booking.create': 'branch', 'client.create': 'branch', 'client_record.write': 'own' });
  });
});
