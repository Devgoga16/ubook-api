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

async function report(token: string, body: Record<string, unknown> = {}, status = 201) {
  const proof = await http().post('/api/billing/proof').auth(token, bearer).attach('file', PNG, 'pago.png').expect(201);
  return http()
    .post('/api/billing/payments')
    .auth(token, bearer)
    .send({ planCode: 'pro', billingCycle: 'monthly', amount: 33000, currency: 'PEN', method: 'yape', reference: 'OP-123456', paidOn: '2026-10-06', proofKey: proof.body.key, ...body })
    .expect(status);
}

async function platformToken(): Promise<string> {
  const res = await http().post('/api/auth/login').send(SUPERADMIN).expect(200);
  return sessionFrom(res).token;
}

describe('Cobro de la suscripción', () => {
  it('el negocio reporta su pago aunque la prueba haya vencido y la plataforma lo aprueba', async () => {
    const owner = await registerBusiness(ctx.app);
    const orgId = owner.body.context.organizationId as string;
    const admin = await platformToken();

    // La prueba vence: el negocio queda en solo lectura, pero puede pagar.
    await http()
      .patch(`/api/platform/organizations/${orgId}/subscription`)
      .auth(admin, bearer)
      .send({ trialEndsAt: new Date(Date.now() - 60_000).toISOString() })
      .expect(200);
    await http().post('/api/clients').auth(owner.token, bearer).send({ firstName: 'X' }).expect(402);

    const overview = (await http().get('/api/billing').auth(owner.token, bearer).expect(200)).body;
    expect(overview.subscription).toMatchObject({ planCode: 'pro', status: 'expired' });
    expect(overview.plans.map((p: { code: string }) => p.code)).toEqual(expect.arrayContaining(['starter', 'pro', 'business']));

    // La evidencia es obligatoria, propia del negocio y debe ser una imagen de verdad.
    const noProof = { planCode: 'pro', billingCycle: 'monthly', amount: 100, currency: 'PEN', method: 'yape', reference: 'X-1', paidOn: '2026-10-06' };
    await http().post('/api/billing/payments').auth(owner.token, bearer).send(noProof).expect(400);
    expect((await http().post('/api/billing/payments').auth(owner.token, bearer).send({ ...noProof, proofKey: 'billing/otro/x.png' }).expect(400)).body.code).toBe('PROOF_REQUIRED');
    expect((await http().post('/api/billing/proof').auth(owner.token, bearer).attach('file', Buffer.from('no soy una imagen'), 'pago.png').expect(400)).body.code).toBe('INVALID_IMAGE');

    const pending = (await report(owner.token)).body;
    expect(pending.hasProof).toBe(true);
    expect(pending).toMatchObject({ status: 'pending', amount: 33000, method: 'yape' });
    expect((await report(owner.token, {}, 409)).body.code).toBe('PAYMENT_PENDING');

    // Solo el Dueño gestiona la suscripción.
    const adminMember = await sessionAsMember(ctx.app, orgId, 'admin');
    await http().get('/api/billing').auth(adminMember.token, bearer).expect(403);

    const queue = (await http().get('/api/platform/billing/payments').auth(admin, bearer).expect(200)).body;
    expect(queue.find((p: { id: string }) => p.id === pending.id)).toMatchObject({ organization: { name: expect.any(String) } });
    await http().get('/api/platform/billing/payments').auth(owner.token, bearer).expect(403);

    // La plataforma ve la foto con un enlace temporal y firmado.
    const { url } = (await http().get(`/api/platform/billing/payments/${pending.id}/proof`).auth(admin, bearer).expect(200)).body;
    const image = await http().get(url).expect(200);
    expect(image.headers['content-type']).toBe('image/png');
    await http().get(`${url}x`).expect(404);
    await http().get(`/api/billing/payments/${pending.id}/proof`).auth(owner.token, bearer).expect(200);

    const approved = (await http().post(`/api/platform/billing/payments/${pending.id}/approve`).auth(admin, bearer).expect(201)).body;
    expect(approved.status).toBe('approved');
    const days = (Date.parse(approved.periodEnd) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);

    const me = (await http().get('/api/auth/me').auth(owner.token, bearer).expect(200)).body;
    expect(me.subscription).toMatchObject({ status: 'active', readOnly: false, planCode: 'pro' });
    await http().post('/api/clients').auth(owner.token, bearer).send({ firstName: 'Ya puedo' }).expect(201);

    // Un segundo pago anual se suma al periodo vigente; uno rechazado deja el motivo.
    const yearly = (await report(owner.token, { billingCycle: 'yearly', amount: 330000, reference: 'OP-999' })).body;
    const extended = (await http().post(`/api/platform/billing/payments/${yearly.id}/approve`).auth(admin, bearer).expect(201)).body;
    expect(Date.parse(extended.periodEnd) - Date.parse(approved.periodEnd)).toBeGreaterThan(360 * 86_400_000);

    const bad = (await report(owner.token, { reference: 'OP-FALSO' })).body;
    await http().post(`/api/platform/billing/payments/${bad.id}/reject`).auth(admin, bearer).send({ reason: 'No encontramos la operación' }).expect(201);
    const history = (await http().get('/api/billing').auth(owner.token, bearer).expect(200)).body.payments;
    expect(history[0]).toMatchObject({ status: 'rejected', rejectReason: 'No encontramos la operación' });
  });
});

describe('Superadmin: cuenta del negocio', () => {
  it('ve y edita los datos del negocio, del dueño y la suscripción', async () => {
    const owner = await registerBusiness(ctx.app, { name: 'Spa Luna' });
    const other = await registerBusiness(ctx.app, { name: 'Spa Sol' });
    const orgId = owner.body.context.organizationId as string;
    const admin = await platformToken();
    await http().post('/api/clients').auth(owner.token, bearer).send({ firstName: 'Cliente' }).expect(201);

    const d = (await http().get(`/api/platform/organizations/${orgId}`).auth(admin, bearer).expect(200)).body;
    expect(d.organization).toMatchObject({ name: 'Spa Luna', status: 'active', timezone: 'America/Lima' });
    expect(d.owners).toEqual([expect.objectContaining({ firstName: 'Ana', email: owner.email })]);
    expect(d.subscription).toMatchObject({ planCode: 'pro', effectiveStatus: 'trialing' });
    expect(d.subscription.features.find((f: { key: string }) => f.key === 'max_branches')).toMatchObject({ label: 'Sucursales', plan: 3, effective: 3 });
    expect(d.usage).toMatchObject({ branches: 1, members: 1, clients: 1 });
    await http().get(`/api/platform/organizations/${orgId}`).auth(owner.token, bearer).expect(403);

    // Negocio: nombre y dirección de reservas (única).
    const otherSlug = (await http().get('/api/organization').auth(other.token, bearer)).body.slug;
    expect((await http().patch(`/api/platform/organizations/${orgId}`).auth(admin, bearer).send({ slug: otherSlug }).expect(409)).body.code).toBe('SLUG_TAKEN');
    const updated = (await http().patch(`/api/platform/organizations/${orgId}`).auth(admin, bearer).send({ name: 'Spa Luna Llena', slug: 'spa-luna-llena', businessType: 'spa' }).expect(200)).body;
    expect(updated.organization).toMatchObject({ name: 'Spa Luna Llena', slug: 'spa-luna-llena', businessType: 'spa' });

    // Dueño: corrige su correo y celular; inicia sesión con el correo nuevo.
    const userId = d.owners[0].userId as string;
    await http().patch(`/api/platform/organizations/${orgId}/owners/${userId}`).auth(admin, bearer).send({ email: other.email }).expect(409);
    await http()
      .patch(`/api/platform/organizations/${orgId}/owners/${userId}`)
      .auth(admin, bearer)
      .send({ email: 'Nuevo.Dueno@SpaLuna.test', phone: '+51 987 000 111', lastName: 'Pérez Luna' })
      .expect(200);
    await http().post('/api/auth/login').send({ email: 'nuevo.dueno@spaluna.test', password: owner.password }).expect(200);

    // Suscripción con excepción de límite.
    await http().patch(`/api/platform/organizations/${orgId}/subscription`).auth(admin, bearer).send({ overrides: { max_branches: 5 } }).expect(200);
    const after = (await http().get(`/api/platform/organizations/${orgId}`).auth(admin, bearer).expect(200)).body;
    expect(after.subscription.features.find((f: { key: string }) => f.key === 'max_branches')).toMatchObject({ plan: 3, override: 5, effective: 5 });
  });
});
