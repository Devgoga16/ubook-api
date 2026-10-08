import request from 'supertest';
import { closeTestApp, createTestApp, registerBusiness, type TestContext } from './helpers.js';

let ctx: TestContext;
const http = () => request(ctx.app.getHttpServer());

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
const resetToken = async (email: string) => {
  const mail = [...(await outbox())].reverse().find((m) => m.to === email && m.subject.includes('contraseña'));
  return mail?.text.match(/\/restablecer\/([\w-]+)/)?.[1];
};

describe('Recuperar contraseña', () => {
  it('envía el enlace, cambia la contraseña una sola vez y cierra las sesiones', async () => {
    const owner = await registerBusiness(ctx.app);
    await http().post('/api/auth/forgot-password').send({ email: owner.email.toUpperCase() }).expect(204);
    const token = await resetToken(owner.email);
    expect(token).toBeTruthy();

    expect((await http().get(`/api/auth/password-reset/${token}`).expect(200)).body.email).toMatch(/^ow•+@test\.com$/);
    expect((await http().post('/api/auth/reset-password').send({ token, password: 'corta' }).expect(400)).body.code).toBe('VALIDATION_ERROR');

    await http().post('/api/auth/reset-password').send({ token, password: 'NuevaClave2026' }).expect(204);

    // La sesión anterior queda cerrada: el refresh deja de funcionar.
    await http().post('/api/auth/refresh').set('Cookie', owner.cookie).expect(401);
    await http().post('/api/auth/login').send({ email: owner.email, password: owner.password }).expect(401);
    await http().post('/api/auth/login').send({ email: owner.email, password: 'NuevaClave2026' }).expect(200);

    // El enlace no se puede volver a usar.
    expect((await http().post('/api/auth/reset-password').send({ token, password: 'OtraClave2026x' }).expect(400)).body.code).toBe('INVALID_RESET_LINK');
    expect((await http().get(`/api/auth/password-reset/${token}`).expect(400)).body.code).toBe('INVALID_RESET_LINK');
  });

  it('responde igual si el correo no existe, y un enlace nuevo invalida el anterior', async () => {
    const before = (await outbox()).length;
    await http().post('/api/auth/forgot-password').send({ email: 'nadie@test.com' }).expect(204);
    expect((await outbox()).length).toBe(before);

    const owner = await registerBusiness(ctx.app);
    await http().post('/api/auth/forgot-password').send({ email: owner.email }).expect(204);
    const first = await resetToken(owner.email);
    await http().post('/api/auth/forgot-password').send({ email: owner.email }).expect(204);
    const second = await resetToken(owner.email);
    expect(second).not.toBe(first);
    expect((await http().post('/api/auth/reset-password').send({ token: first, password: 'NuevaClave2026' }).expect(400)).body.code).toBe('INVALID_RESET_LINK');
    await http().post('/api/auth/reset-password').send({ token: second, password: 'NuevaClave2026' }).expect(204);
  });
});
