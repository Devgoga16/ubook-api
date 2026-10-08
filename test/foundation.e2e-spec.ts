import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import { TenantContext } from '../src/core/tenancy/tenant-context.js';
import { Membership } from '../src/modules/organization/schemas/membership.schema.js';
import { Role } from '../src/modules/organization/schemas/role.schema.js';
import {
  closeTestApp,
  createTestApp,
  registerBusiness,
  sessionFrom,
  SUPERADMIN,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
const http = () => request(ctx.app.getHttpServer());

beforeAll(async () => {
  ctx = await createTestApp();
}, 180_000);

afterAll(async () => {
  await closeTestApp(ctx);
});

describe('Planes', () => {
  it('lista los planes públicos sembrados al iniciar', async () => {
    const res = await http().get('/api/plans').expect(200);
    expect(res.body.map((p: { code: string }) => p.code)).toEqual(['starter', 'pro', 'business']);
    expect(res.body[0].features.client_records).toBe(true);
    expect(res.body[1].price).toEqual({ monthly: 7900, yearly: 79000, currency: 'PEN' });
    expect(res.body[0].id).toBeDefined();
    expect(res.body[0]._id).toBeUndefined();
  });
});

describe('Registro de negocio', () => {
  it('crea dueño, negocio, roles, sucursal y prueba gratis de 30 días', async () => {
    const owner = await registerBusiness(ctx.app);
    expect(owner.body.context.ctx).toBe('staff');
    expect(owner.cookie).toMatch(/^ubook_rt=/);

    const me = await http().get('/api/auth/me').auth(owner.token, { type: 'bearer' }).expect(200);
    expect(me.body.user.passwordHash).toBeUndefined();
    expect(me.body.access.isOwner).toBe(true);
    expect(me.body.subscription.status).toBe('trialing');
    expect(me.body.subscription.planCode).toBe('pro');
    const trialDays = (new Date(me.body.subscription.trialEndsAt).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(trialDays)).toBe(30);

    const roles = await http().get('/api/roles').auth(owner.token, { type: 'bearer' }).expect(200);
    expect(roles.body.map((r: { name: string }) => r.name)).toEqual([
      'Dueño',
      'Administrador',
      'Recepción',
      'Profesional',
    ]);

    const branches = await http().get('/api/branches').auth(owner.token, { type: 'bearer' }).expect(200);
    expect(branches.body).toHaveLength(1);
    expect(branches.body[0].timezone).toBe('America/Lima');
  });

  it('rechaza un email ya registrado', async () => {
    const owner = await registerBusiness(ctx.app);
    await http()
      .post('/api/auth/register')
      .send({
        firstName: 'X',
        lastName: 'Y',
        email: owner.email,
        password: 'Password1234',
        organization: { name: 'Otro', timezone: 'America/Lima' },
      })
      .expect(409);
  });

  it('valida los datos de entrada y devuelve los campos con error', async () => {
    const res = await http()
      .post('/api/auth/register')
      .send({ email: 'no-es-email', password: 'corta', organization: { name: 'X', timezone: 'Mars/Base' } })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.body.details.fields)).toEqual(
      expect.arrayContaining(['email', 'password', 'firstName', 'organization.name', 'organization.timezone']),
    );
  });
});

describe('Aislamiento entre negocios', () => {
  it('un negocio no ve ni modifica datos de otro', async () => {
    const a = await registerBusiness(ctx.app);
    const b = await registerBusiness(ctx.app);

    const aBranches = await http().get('/api/branches').auth(a.token, { type: 'bearer' }).expect(200);
    const bBranches = await http().get('/api/branches').auth(b.token, { type: 'bearer' }).expect(200);
    expect(aBranches.body[0].id).not.toBe(bBranches.body[0].id);
    expect(bBranches.body).toHaveLength(1);

    await http()
      .patch(`/api/branches/${aBranches.body[0].id}`)
      .auth(b.token, { type: 'bearer' })
      .send({ name: 'Hackeada' })
      .expect(404);
  });

  it('el plugin falla si se consulta sin organización en contexto', async () => {
    const roles = ctx.app.get<Model<Role>>(getModelToken(Role.name));
    await expect(roles.find().exec()).rejects.toThrow(/sin organización en contexto/);
    await expect(TenantContext.runAsSystem(() => roles.countDocuments().exec())).resolves.toBeGreaterThan(0);
  });
});

describe('Límites y funcionalidades del plan', () => {
  it('bloquea crear una sucursal por encima del límite', async () => {
    const owner = await registerBusiness(ctx.app, { planCode: 'starter' });
    const res = await http()
      .post('/api/branches')
      .auth(owner.token, { type: 'bearer' })
      .send({ name: 'Segunda' })
      .expect(403);
    expect(res.body.code).toBe('PLAN_LIMIT_REACHED');
  });

  it('el plan Starter no permite roles personalizados; Pro sí', async () => {
    const basic = await registerBusiness(ctx.app, { planCode: 'starter' });
    const denied = await http()
      .post('/api/roles')
      .auth(basic.token, { type: 'bearer' })
      .send({ name: 'Asistente', permissions: [{ key: 'booking.read', scope: 'branch' }] })
      .expect(403);
    expect(denied.body.code).toBe('FEATURE_NOT_IN_PLAN');

    const pro = await registerBusiness(ctx.app);
    await http()
      .post('/api/roles')
      .auth(pro.token, { type: 'bearer' })
      .send({ name: 'Asistente', permissions: [{ key: 'booking.read', scope: 'branch' }] })
      .expect(201);
  });

  it('rechaza un alcance no permitido para el permiso', async () => {
    const owner = await registerBusiness(ctx.app);
    const res = await http()
      .post('/api/roles')
      .auth(owner.token, { type: 'bearer' })
      .send({ name: 'Raro', permissions: [{ key: 'audit.read', scope: 'own' }] })
      .expect(400);
    expect(res.body.code).toBe('INVALID_SCOPE');
  });

  it('el registro de auditoría solo está en el plan Business', async () => {
    const pro = await registerBusiness(ctx.app);
    await http().get('/api/audit-logs').auth(pro.token, { type: 'bearer' }).expect(403);

    const business = await registerBusiness(ctx.app, { planCode: 'business' });
    const logs = await http().get('/api/audit-logs').auth(business.token, { type: 'bearer' }).expect(200);
    expect(logs.body.some((l: { action: string }) => l.action === 'organization.created')).toBe(true);
  });
});

describe('Roles, permisos y cambio de negocio', () => {
  it('un profesional con acceso a dos negocios elige uno y solo tiene sus permisos', async () => {
    const a = await registerBusiness(ctx.app);
    const pro = await registerBusiness(ctx.app); // su propio negocio

    // Lo agregamos como Profesional al negocio A (la invitación llega en otra fase).
    const orgA = a.body.context.organizationId as string;
    const memberships = ctx.app.get<Model<Membership>>(getModelToken(Membership.name));
    const roles = ctx.app.get<Model<Role>>(getModelToken(Role.name));
    const proUserId = (
      await http().get('/api/auth/me').auth(pro.token, { type: 'bearer' }).expect(200)
    ).body.user.id;
    await TenantContext.runForOrganization(orgA, async () => {
      const role = await roles.findOne({ templateKey: 'professional' }).exec();
      await memberships.create({ userId: proUserId, roleIds: [role!._id] });
    });

    const login = await http()
      .post('/api/auth/login')
      .send({ email: pro.email, password: pro.password })
      .expect(200);
    expect(login.body.context.ctx).toBe('account');
    const session = sessionFrom(login);

    // En contexto `account` no puede operar sobre un negocio.
    await http().get('/api/branches').auth(session.token, { type: 'bearer' }).expect(403);

    const me = await http().get('/api/auth/me').auth(session.token, { type: 'bearer' }).expect(200);
    expect(me.body.organizations).toHaveLength(2);

    const switched = await http()
      .post('/api/auth/switch-organization')
      .set('Cookie', session.cookie)
      .auth(session.token, { type: 'bearer' })
      .send({ organizationId: orgA })
      .expect(200);
    const inA = sessionFrom(switched);

    const meA = await http().get('/api/auth/me').auth(inA.token, { type: 'bearer' }).expect(200);
    expect(meA.body.access.isOwner).toBe(false);
    expect(meA.body.access.permissions['booking.read']).toBe('own');
    expect(meA.body.access.permissions['role.read']).toBeUndefined();

    await http().get('/api/roles').auth(inA.token, { type: 'bearer' }).expect(403);
    await http().patch('/api/organization').auth(inA.token, { type: 'bearer' }).send({ name: 'X' }).expect(403);
  });

  it('no permite dejar el negocio sin Dueño', async () => {
    const owner = await registerBusiness(ctx.app);
    const members = await http().get('/api/members').auth(owner.token, { type: 'bearer' }).expect(200);
    const roles = await http().get('/api/roles').auth(owner.token, { type: 'bearer' }).expect(200);
    const admin = roles.body.find((r: { name: string }) => r.name === 'Administrador');

    const res = await http()
      .patch(`/api/members/${members.body[0].id}`)
      .auth(owner.token, { type: 'bearer' })
      .send({ roleIds: [admin.id] })
      .expect(409);
    expect(res.body.code).toBe('LAST_OWNER');
  });

  it('el rol Dueño no se puede editar ni eliminar', async () => {
    const owner = await registerBusiness(ctx.app);
    const roles = await http().get('/api/roles').auth(owner.token, { type: 'bearer' }).expect(200);
    const ownerRole = roles.body.find((r: { name: string }) => r.name === 'Dueño');
    await http().delete(`/api/roles/${ownerRole.id}`).auth(owner.token, { type: 'bearer' }).expect(403);
  });
});

describe('Sesiones', () => {
  it('rota el refresh token y revoca todo si se reutiliza uno viejo', async () => {
    const owner = await registerBusiness(ctx.app);

    const first = await http().post('/api/auth/refresh').set('Cookie', owner.cookie).expect(200);
    const rotated = sessionFrom(first);
    expect(rotated.cookie).not.toBe(owner.cookie);
    expect(first.body.context.ctx).toBe('staff');

    // Reutilizar el token anterior = posible robo → se revoca la familia.
    await http().post('/api/auth/refresh').set('Cookie', owner.cookie).expect(401);
    await http().post('/api/auth/refresh').set('Cookie', rotated.cookie).expect(401);
  });

  it('logout invalida el refresh token', async () => {
    const owner = await registerBusiness(ctx.app);
    await http().post('/api/auth/logout').set('Cookie', owner.cookie).expect(204);
    await http().post('/api/auth/refresh').set('Cookie', owner.cookie).expect(401);
  });

  it('credenciales incorrectas devuelven 401 genérico', async () => {
    const owner = await registerBusiness(ctx.app);
    const res = await http()
      .post('/api/auth/login')
      .send({ email: owner.email, password: 'incorrecta123' })
      .expect(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    await http()
      .post('/api/auth/login')
      .send({ email: 'nadie@test.com', password: 'incorrecta123' })
      .expect(401);
  });
});

describe('Super admin', () => {
  it('gestiona suscripciones y una suscripción vencida deja el negocio en solo lectura', async () => {
    const owner = await registerBusiness(ctx.app, { name: 'Spa Vencido' });
    const orgId = owner.body.context.organizationId as string;

    // Un token de staff no entra al panel de plataforma.
    const wrong = await http().get('/api/platform/organizations').auth(owner.token, { type: 'bearer' }).expect(403);
    expect(wrong.body.code).toBe('WRONG_CONTEXT');

    const login = await http().post('/api/auth/login').send(SUPERADMIN).expect(200);
    expect(login.body.context.ctx).toBe('platform');
    const admin = login.body.accessToken as string;

    const list = await http()
      .get('/api/platform/organizations?search=vencido')
      .auth(admin, { type: 'bearer' })
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].subscription.effectiveStatus).toBe('trialing');

    await http()
      .patch(`/api/platform/organizations/${orgId}/subscription`)
      .auth(admin, { type: 'bearer' })
      .send({ status: 'expired' })
      .expect(200);

    await http().get('/api/branches').auth(owner.token, { type: 'bearer' }).expect(200);
    const blocked = await http()
      .patch('/api/organization')
      .auth(owner.token, { type: 'bearer' })
      .send({ name: 'Nuevo nombre' })
      .expect(402);
    expect(blocked.body.code).toBe('SUBSCRIPTION_INACTIVE');

    // Reactivación manual con excepción de +1 sucursal.
    await http()
      .patch(`/api/platform/organizations/${orgId}/subscription`)
      .auth(admin, { type: 'bearer' })
      .send({
        status: 'active',
        planCode: 'starter',
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        overrides: { max_branches: 2 },
      })
      .expect(200);
    await http()
      .post('/api/branches')
      .auth(owner.token, { type: 'bearer' })
      .send({ name: 'Segunda' })
      .expect(201);
  });

  it('el super admin puede editar planes; un dueño no', async () => {
    const owner = await registerBusiness(ctx.app);
    await http()
      .patch('/api/platform/plans/starter')
      .auth(owner.token, { type: 'bearer' })
      .send({ name: 'X' })
      .expect(403);

    const admin = (await http().post('/api/auth/login').send(SUPERADMIN).expect(200)).body.accessToken;
    const res = await http()
      .patch('/api/platform/plans/starter')
      .auth(admin, { type: 'bearer' })
      .send({ price: { monthly: 1500, yearly: 15000, currency: 'USD' }, features: { max_professionals: 3 } })
      .expect(200);
    expect(res.body.features.max_professionals).toBe(3);

    await http()
      .patch('/api/platform/plans/starter')
      .auth(admin, { type: 'bearer' })
      .send({ features: { max_professionals: 'muchos' } })
      .expect(400);
  });
});

describe('Planes en soles', () => {
  it('pasa a soles los planes que aún tienen los precios iniciales en dólares', async () => {
    const { PlansService } = await import('../src/modules/platform/plans.service.js');
    const { getConnectionToken } = await import('@nestjs/mongoose');
    const db = ctx.app.get(getConnectionToken()).db;
    await db.collection('plans').updateOne({ code: 'starter' }, { $set: { price: { monthly: 2900, yearly: 29000, currency: 'USD' } } });
    await ctx.app.get(PlansService).seedDefaults();
    const res = await request(ctx.app.getHttpServer()).get('/api/plans').expect(200);
    expect(res.body.map((p: { code: string; price: unknown }) => [p.code, p.price])).toEqual([
      ['starter', { monthly: 4900, yearly: 49000, currency: 'PEN' }],
      ['pro', { monthly: 7900, yearly: 79000, currency: 'PEN' }],
      ['business', { monthly: 12900, yearly: 129000, currency: 'PEN' }],
    ]);
  });
});
