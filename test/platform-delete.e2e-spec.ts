import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConnectionToken } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import request from 'supertest';
import { closeTestApp, createTestApp, registerBusiness, sessionAsMember, sessionFrom, SUPERADMIN, type TestContext } from './helpers.js';

let ctx: TestContext;
const http = () => request(ctx.app.getHttpServer());
const bearer = { type: 'bearer' as const };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

beforeAll(async () => {
  ctx = await createTestApp();
}, 180_000);

afterAll(async () => {
  await closeTestApp(ctx);
});

describe('Superadmin: eliminar un negocio', () => {
  it('borra el negocio con todos sus datos, archivos y cuentas propias, sin tocar a otros', async () => {
    const owner = await registerBusiness(ctx.app);
    const org = (await http().get('/api/organization').auth(owner.token, bearer).expect(200)).body;
    const orgId = org.id as string;

    // Datos de todo tipo en el negocio.
    await http().post('/api/services').auth(owner.token, bearer).send({ name: 'Corte', durationMinutes: 30, price: 3000 }).expect(201);
    await http().post('/api/clients').auth(owner.token, bearer).send({ firstName: 'Mateo', lastName: 'Huamán', phone: '987654321' }).expect(201);
    await http().post(`/api/public/businesses/${org.slug}/uploads`).attach('file', PNG, 'yape.png').expect(201);
    const proof = (await http().post('/api/billing/proof').auth(owner.token, bearer).attach('file', PNG, 'pago.png').expect(201)).body;
    await http()
      .post('/api/billing/payments')
      .auth(owner.token, bearer)
      .send({ planCode: 'pro', billingCycle: 'monthly', amount: 100, currency: 'PEN', method: 'yape', reference: 'OP-1', paidOn: '2026-10-06', proofKey: proof.key })
      .expect(201);
    // Alguien del equipo que además tiene su propio negocio: su cuenta debe quedar.
    const member = await sessionAsMember(ctx.app, orgId, 'receptionist');
    const memberMe = (await http().get('/api/auth/me').auth(member.token, bearer).expect(200)).body;

    // Otro negocio que no debe tocarse.
    const other = await registerBusiness(ctx.app);
    await http().post('/api/services').auth(other.token, bearer).send({ name: 'Manicure', durationMinutes: 45, price: 4000 }).expect(201);

    const admin = sessionFrom(await http().post('/api/auth/login').send(SUPERADMIN).expect(200)).token;
    await http().delete(`/api/platform/organizations/${orgId}`).auth(owner.token, bearer).send({ confirm: org.slug }).expect(403);
    expect((await http().delete(`/api/platform/organizations/${orgId}`).auth(admin, bearer).send({ confirm: 'otro' }).expect(400)).body.code).toBe('CONFIRMATION_MISMATCH');

    const summary = (await http().delete(`/api/platform/organizations/${orgId}`).auth(admin, bearer).send({ confirm: org.slug.toUpperCase() }).expect(200)).body;
    expect(summary).toMatchObject({ slug: org.slug, users: 1 });
    expect(summary.removed).toMatchObject({ services: 1, clients: 1, memberships: 2, subscriptions: 1, subscription_payments: 1 });

    // Ninguna colección conserva datos del negocio.
    const db = ctx.app.get<Connection>(getConnectionToken()).db!;
    const oid = new Types.ObjectId(orgId);
    for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
      expect([name, await db.collection(name).countDocuments({ organizationId: oid })]).toEqual([name, 0]);
    }
    expect(await db.collection('organizations').countDocuments({ _id: oid })).toBe(0);
    expect(existsSync(join(tmpdir(), 'ubook-test-uploads', 'deposits', orgId))).toBe(false);
    expect(existsSync(join(tmpdir(), 'ubook-test-uploads', 'billing', orgId))).toBe(false);
    expect(await db.collection('audit_logs').countDocuments({ action: 'platform.organization_deleted', entityId: orgId })).toBe(1);

    // El dueño (solo estaba en este negocio) ya no existe; el miembro sigue con su cuenta.
    await http().post('/api/auth/login').send({ email: owner.email, password: owner.password }).expect(401);
    expect(await db.collection('users').countDocuments({ _id: new Types.ObjectId(memberMe.user.id) })).toBe(1);
    await http().get(`/api/public/businesses/${org.slug}`).expect(404);
    await http().get(`/api/platform/organizations/${orgId}`).auth(admin, bearer).expect(404);

    // El otro negocio sigue intacto.
    expect((await http().get('/api/services').auth(other.token, bearer).expect(200)).body).toHaveLength(1);
  });
});
