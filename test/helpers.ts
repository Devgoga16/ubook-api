import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Model } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import type { App } from 'supertest/types.js';

export const SUPERADMIN = { email: 'root@ubook.test', password: 'SuperSecret123!' };

export interface TestContext {
  app: INestApplication<App>;
  mongo: MongoMemoryReplSet;
}

/** Levanta la API completa contra un replica set de Mongo en memoria. */
export async function createTestApp(): Promise<TestContext> {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGODB_URI: mongo.getUri('ubook_test'),
    JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-123',
    SUPERADMIN_EMAIL: SUPERADMIN.email,
    SUPERADMIN_PASSWORD: SUPERADMIN.password,
  });

  // Import dinámico: ConfigModule lee process.env al importarse.
  const { AppModule } = await import('../src/app.module.js');
  const { configureApp } = await import('../src/app.setup.js');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return { app, mongo };
}

export async function closeTestApp(ctx: TestContext | undefined): Promise<void> {
  await ctx?.app.close();
  await ctx?.mongo.stop();
}

export interface Session {
  token: string;
  cookie: string;
  body: Record<string, any>;
}

export function sessionFrom(res: request.Response): Session {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith('ubook_rt='))?.split(';')[0] ?? '';
  return { token: res.body.accessToken, cookie, body: res.body };
}

let counter = 0;

export async function registerBusiness(
  app: INestApplication<App>,
  overrides: { planCode?: string; name?: string; email?: string } = {},
): Promise<Session & { email: string; password: string }> {
  counter += 1;
  const email = overrides.email ?? `owner${counter}@test.com`;
  const password = 'Password1234';
  const res = await request(app.getHttpServer())
    .post('/api/auth/register')
    .send({
      firstName: 'Ana',
      lastName: 'Pérez',
      email,
      password,
      organization: {
        name: overrides.name ?? `Barbería ${counter}`,
        timezone: 'America/Lima',
        ...(overrides.planCode && { planCode: overrides.planCode }),
      },
    })
    .expect(201);
  return { ...sessionFrom(res), email, password };
}

/**
 * Crea un usuario que es miembro de `organizationId` con el rol de plantilla
 * indicado y devuelve su sesión dentro de ese negocio. (La invitación por
 * email llega en otra fase.)
 */
export async function sessionAsMember(
  app: INestApplication<App>,
  organizationId: string,
  roleTemplate: 'admin' | 'receptionist' | 'professional',
): Promise<Session> {
  const { TenantContext } = await import('../src/core/tenancy/tenant-context.js');
  const { Membership } = await import('../src/modules/organization/schemas/membership.schema.js');
  const { Role } = await import('../src/modules/organization/schemas/role.schema.js');

  const own = await registerBusiness(app); // el usuario necesita una cuenta
  const me = await request(app.getHttpServer()).get('/api/auth/me').auth(own.token, { type: 'bearer' });
  const memberships = app.get<Model<unknown>>(getModelToken(Membership.name));
  const roles = app.get<Model<{ templateKey: string | null }>>(getModelToken(Role.name));
  await TenantContext.runForOrganization(organizationId, async () => {
    const role = await roles.findOne({ templateKey: roleTemplate }).exec();
    await memberships.create({ userId: me.body.user.id, roleIds: [role!._id] });
  });

  const switched = await request(app.getHttpServer())
    .post('/api/auth/switch-organization')
    .set('Cookie', own.cookie)
    .auth(own.token, { type: 'bearer' })
    .send({ organizationId })
    .expect(200);
  return sessionFrom(switched);
}
