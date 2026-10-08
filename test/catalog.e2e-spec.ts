import request from 'supertest';
import {
  closeTestApp,
  createTestApp,
  registerBusiness,
  sessionAsMember,
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

const corteBarba = {
  name: 'Corte + barba',
  durationMinutes: 45,
  price: 5000,
  bufferAfterMinutes: 10,
  deposit: { enabled: true, type: 'percent', value: 30 },
  color: '#575B9F',
};

describe('Servicios', () => {
  it('crea, lista, edita y archiva un servicio con categoría', async () => {
    const owner = await registerBusiness(ctx.app);
    const auth = { type: 'bearer' as const };

    const category = await http()
      .post('/api/service-categories')
      .auth(owner.token, auth)
      .send({ name: 'Cortes' })
      .expect(201);

    const created = await http()
      .post('/api/services')
      .auth(owner.token, auth)
      .send({ ...corteBarba, categoryId: category.body.id })
      .expect(201);
    expect(created.body).toMatchObject({
      name: 'Corte + barba',
      price: 5000,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 10,
      onlineBooking: true,
      isArchived: false,
      deposit: { enabled: true, type: 'percent', value: 30 },
    });

    await http()
      .patch(`/api/services/${created.body.id}`)
      .auth(owner.token, auth)
      .send({ price: 5500, onlineBooking: false })
      .expect(200);

    await http()
      .patch(`/api/services/${created.body.id}`)
      .auth(owner.token, auth)
      .send({ isArchived: true })
      .expect(200);

    const active = await http().get('/api/services').auth(owner.token, auth).expect(200);
    expect(active.body).toHaveLength(0);

    const all = await http().get('/api/services?includeArchived=true').auth(owner.token, auth).expect(200);
    expect(all.body).toHaveLength(1);
    expect(all.body[0]).toMatchObject({ price: 5500, onlineBooking: false, isArchived: true });

    const notArchived = await http().get('/api/services?includeArchived=false').auth(owner.token, auth).expect(200);
    expect(notArchived.body).toHaveLength(0);
  });

  it('una edición parcial no borra los demás campos', async () => {
    const owner = await registerBusiness(ctx.app);
    const auth = { type: 'bearer' as const };
    const created = await http().post('/api/services').auth(owner.token, auth).send(corteBarba).expect(201);

    await http().patch(`/api/services/${created.body.id}`).auth(owner.token, auth).send({ price: 5550 }).expect(200);

    const list = await http().get('/api/services').auth(owner.token, auth).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ name: 'Corte + barba', price: 5550, durationMinutes: 45, isArchived: false });

    // Lo mismo para negocio y sucursal.
    await http().patch('/api/organization').auth(owner.token, auth).send({ name: 'Nuevo nombre' }).expect(200);
    const org = await http().get('/api/organization').auth(owner.token, auth).expect(200);
    expect(org.body).toMatchObject({ name: 'Nuevo nombre', timezone: 'America/Lima', currency: 'PEN' });
    expect(org.body.slug).toBeTruthy();

    const [branch] = (await http().get('/api/branches').auth(owner.token, auth)).body;
    await http().patch(`/api/branches/${branch.id}`).auth(owner.token, auth).send({ address: 'Av. Larco 812' }).expect(200);
    const branches = await http().get('/api/branches').auth(owner.token, auth).expect(200);
    expect(branches.body[0]).toMatchObject({ name: 'Principal', address: 'Av. Larco 812', isActive: true });
  });

  it('valida duración, precio, depósito y categoría', async () => {
    const owner = await registerBusiness(ctx.app);
    const auth = { type: 'bearer' as const };

    const invalid = await http()
      .post('/api/services')
      .auth(owner.token, auth)
      .send({ name: 'X', durationMinutes: 2, price: -1 })
      .expect(400);
    expect(Object.keys(invalid.body.details.fields)).toEqual(
      expect.arrayContaining(['name', 'durationMinutes', 'price']),
    );

    const deposit = await http()
      .post('/api/services')
      .auth(owner.token, auth)
      .send({ ...corteBarba, deposit: { enabled: true, type: 'percent', value: 150 } })
      .expect(400);
    expect(deposit.body.code).toBe('INVALID_DEPOSIT');

    const category = await http()
      .post('/api/services')
      .auth(owner.token, auth)
      .send({ ...corteBarba, categoryId: '0123456789abcdef01234567' })
      .expect(400);
    expect(category.body.code).toBe('INVALID_CATEGORY');
  });

  it('eliminar una categoría deja sus servicios sin categoría', async () => {
    const owner = await registerBusiness(ctx.app);
    const auth = { type: 'bearer' as const };
    const category = await http().post('/api/service-categories').auth(owner.token, auth).send({ name: 'Uñas' });
    await http()
      .post('/api/services')
      .auth(owner.token, auth)
      .send({ ...corteBarba, name: 'Manicure', categoryId: category.body.id })
      .expect(201);

    await http().delete(`/api/service-categories/${category.body.id}`).auth(owner.token, auth).expect(204);
    const services = await http().get('/api/services').auth(owner.token, auth).expect(200);
    expect(services.body[0].categoryId).toBeNull();

    await http().post('/api/service-categories').auth(owner.token, auth).send({ name: 'Color' }).expect(201);
    await http().post('/api/service-categories').auth(owner.token, auth).send({ name: 'Color' }).expect(409);
  });

  it('otro negocio no ve ni edita los servicios', async () => {
    const a = await registerBusiness(ctx.app);
    const b = await registerBusiness(ctx.app);
    const service = await http()
      .post('/api/services')
      .auth(a.token, { type: 'bearer' })
      .send(corteBarba)
      .expect(201);

    const list = await http().get('/api/services').auth(b.token, { type: 'bearer' }).expect(200);
    expect(list.body).toHaveLength(0);
    await http().get(`/api/services/${service.body.id}`).auth(b.token, { type: 'bearer' }).expect(404);
    await http()
      .patch(`/api/services/${service.body.id}`)
      .auth(b.token, { type: 'bearer' })
      .send({ price: 1 })
      .expect(404);
  });

  it('un profesional puede ver los servicios pero no editarlos', async () => {
    const owner = await registerBusiness(ctx.app);
    const orgId = owner.body.context.organizationId as string;
    await http().post('/api/services').auth(owner.token, { type: 'bearer' }).send(corteBarba).expect(201);

    const pro = await sessionAsMember(ctx.app, orgId, 'professional');
    const list = await http().get('/api/services').auth(pro.token, { type: 'bearer' }).expect(200);
    expect(list.body).toHaveLength(1);
    await http().post('/api/services').auth(pro.token, { type: 'bearer' }).send(corteBarba).expect(403);
    await http()
      .post('/api/service-categories')
      .auth(pro.token, { type: 'bearer' })
      .send({ name: 'Nueva' })
      .expect(403);
  });
});
