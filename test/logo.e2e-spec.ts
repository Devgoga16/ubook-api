import request from 'supertest';
import { closeTestApp, createTestApp, registerBusiness, sessionAsMember, type TestContext } from './helpers.js';

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

describe('Logo del negocio', () => {
  it('se sube, se ve en la app y en la página de reservas, se reemplaza y se quita', async () => {
    const owner = await registerBusiness(ctx.app);
    const org = (await http().get('/api/organization').auth(owner.token, bearer).expect(200)).body;
    expect(org.logoUrl).toBeNull();
    expect(org).not.toHaveProperty('logoKey');

    expect((await http().post('/api/organization/logo').auth(owner.token, bearer).attach('file', Buffer.from('texto'), 'logo.png').expect(400)).body.code).toBe('INVALID_IMAGE');

    const first = (await http().post('/api/organization/logo').auth(owner.token, bearer).attach('file', PNG, 'logo.png').expect(200)).body;
    expect(first.logoUrl).toMatch(/^\/api\/files\//);
    const img = await http().get(first.logoUrl as string).expect(200);
    expect(img.headers['content-type']).toBe('image/png');

    const me = (await http().get('/api/auth/me').auth(owner.token, bearer).expect(200)).body;
    expect(me.organization.logoUrl).toMatch(/^\/api\/files\//);
    expect((await http().get(`/api/public/businesses/${org.slug}`).expect(200)).body.logoUrl).toMatch(/^\/api\/files\//);

    const second = (await http().post('/api/organization/logo').auth(owner.token, bearer).attach('file', PNG, 'otro.png').expect(200)).body;
    expect(second.logoUrl).not.toBe(first.logoUrl);
    await http().get(first.logoUrl as string).expect(404); // el anterior se borró

    expect((await http().delete('/api/organization/logo').auth(owner.token, bearer).expect(200)).body.logoUrl).toBeNull();
    expect((await http().get(`/api/public/businesses/${org.slug}`).expect(200)).body.logoUrl).toBeNull();
  });

  it('solo quien gestiona el negocio puede cambiarlo', async () => {
    const owner = await registerBusiness(ctx.app);
    const org = (await http().get('/api/organization').auth(owner.token, bearer).expect(200)).body;
    const pro = await sessionAsMember(ctx.app, org.id as string, 'professional');
    await http().post('/api/organization/logo').auth(pro.token, bearer).attach('file', PNG, 'logo.png').expect(403);
  });
});
