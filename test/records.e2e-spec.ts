import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import { closeTestApp, createTestApp, registerBusiness, sessionAsMember, type Session, type TestContext } from './helpers.js';

let ctx: TestContext;
const http = () => request(ctx.app.getHttpServer());
const bearer = { type: 'bearer' as const };

beforeAll(async () => {
  ctx = await createTestApp();
}, 180_000);

afterAll(async () => {
  await closeTestApp(ctx);
});

async function setup() {
  const owner = await registerBusiness(ctx.app);
  const orgId = owner.body.context.organizationId as string;
  const template = (await http().post('/api/record-templates').auth(owner.token, bearer).send({ preset: 'general' }).expect(201)).body;
  const [reason, notes] = template.fields.map((f: { key: string }) => f.key) as string[];
  const client = (
    await http().post('/api/clients').auth(owner.token, bearer).send({ firstName: 'Lucía', lastName: 'Ramos', phone: '912 345 678' }).expect(201)
  ).body;
  return { owner, orgId, templateId: template.id as string, reason, notes, clientId: client.id as string };
}

const write = (session: Session, clientId: string, body: Record<string, unknown>) =>
  http().post(`/api/clients/${clientId}/records`).auth(session.token, bearer).send(body);

async function rawRecord(id: string) {
  const { TenantContext } = await import('../src/core/tenancy/tenant-context.js');
  const { ClientRecord } = await import('../src/modules/records/schemas/record.schemas.js');
  const model = ctx.app.get<Model<{ payload: string; addenda: Array<{ payload: string }> }>>(getModelToken(ClientRecord.name));
  return TenantContext.runAsSystem(() => model.findById(id).lean().exec());
}

async function auditActions(orgId: string): Promise<string[]> {
  const { TenantContext } = await import('../src/core/tenancy/tenant-context.js');
  const { AuditLog } = await import('../src/core/audit/audit-log.schema.js');
  const model = ctx.app.get<Model<{ action: string; organizationId: unknown }>>(getModelToken(AuditLog.name));
  const logs = await TenantContext.runAsSystem(() => model.find({ organizationId: orgId }).lean().exec());
  return logs.map((l) => l.action);
}

describe('Plantillas de ficha', () => {
  it('copia una plantilla base y valida plantillas propias', async () => {
    const { owner } = await setup();
    const presets = (await http().get('/api/record-templates/presets').auth(owner.token, bearer).expect(200)).body;
    expect(presets.map((p: { key: string }) => p.key)).toEqual(expect.arrayContaining(['general', 'beauty', 'psychology', 'dental']));

    const bad = await http()
      .post('/api/record-templates')
      .auth(owner.token, bearer)
      .send({ name: 'Sin opciones', fields: [{ key: 'tipo', label: 'Tipo', type: 'select', required: false, options: [] }] })
      .expect(400);
    expect(bad.body.code).toBe('INVALID_TEMPLATE');

    const list = (await http().get('/api/record-templates').auth(owner.token, bearer).expect(200)).body;
    expect(list).toHaveLength(1);
  });
});

describe('Fichas clínicas', () => {
  it('se guardan cifradas y cada lectura queda auditada', async () => {
    const s = await setup();
    const created = await write(s.owner, s.clientId, { templateId: s.templateId, values: { [s.reason]: 'Dolor lumbar crónico' } }).expect(201);
    expect(created.body).toMatchObject({ status: 'draft', canEdit: true, values: { [s.reason]: 'Dolor lumbar crónico' } });

    const raw = await rawRecord(created.body.id);
    expect(raw!.payload).toMatch(/^v1:/);
    expect(JSON.stringify(raw)).not.toContain('lumbar');

    const list = await http().get(`/api/clients/${s.clientId}/records`).auth(s.owner.token, bearer).expect(200);
    expect(list.body[0].values[s.reason]).toBe('Dolor lumbar crónico');
    expect(await auditActions(s.orgId)).toEqual(expect.arrayContaining(['client_record.created', 'client_record.viewed']));
  });

  it('para firmar exige los obligatorios; firmada ya no se edita, solo notas de corrección', async () => {
    const s = await setup();
    const draft = (await write(s.owner, s.clientId, { templateId: s.templateId, values: { [s.notes]: 'Algo' } }).expect(201)).body;

    const missing = await http().post(`/api/records/${draft.id}/sign`).auth(s.owner.token, bearer).expect(400);
    expect(missing.body).toMatchObject({ code: 'INVALID_RECORD', details: { fields: { [s.reason]: expect.any(String) } } });

    await http().patch(`/api/records/${draft.id}`).auth(s.owner.token, bearer).send({ values: { [s.reason]: 'Control', [s.notes]: 'Algo' } }).expect(200);
    const signed = await http().post(`/api/records/${draft.id}/sign`).auth(s.owner.token, bearer).expect(201);
    expect(signed.body).toMatchObject({ status: 'signed', canEdit: false });

    const edit = await http().patch(`/api/records/${draft.id}`).auth(s.owner.token, bearer).send({ values: { [s.reason]: 'Otro' } }).expect(409);
    expect(edit.body.code).toBe('RECORD_SIGNED');

    const withNote = await http().post(`/api/records/${draft.id}/addenda`).auth(s.owner.token, bearer).send({ text: 'Corrijo: fue control mensual' }).expect(201);
    expect(withNote.body.addenda).toHaveLength(1);
    expect(withNote.body.addenda[0].text).toBe('Corrijo: fue control mensual');
    expect(withNote.body.values[s.reason]).toBe('Control');
    expect(JSON.stringify(await rawRecord(draft.id))).not.toContain('mensual');
  });

  it('firmar al crear sin obligatorios falla', async () => {
    const s = await setup();
    expect((await write(s.owner, s.clientId, { templateId: s.templateId, values: {}, sign: true }).expect(400)).body.code).toBe('INVALID_RECORD');
  });

  it('un profesional solo escribe para clientes que atiende y solo ve sus propias fichas', async () => {
    const s = await setup();
    await write(s.owner, s.clientId, { templateId: s.templateId, values: { [s.reason]: 'Nota del dueño' } }).expect(201);

    const member = await sessionAsMember(ctx.app, s.orgId, 'professional');
    // Sin citas con este cliente → no puede escribir.
    expect((await write(member, s.clientId, { templateId: s.templateId, values: { [s.reason]: 'x' } })).status).toBe(403);

    // Se le asigna una cita con el cliente.
    const membershipId = (await http().get('/api/auth/me').auth(member.token, bearer)).body.access.membershipId;
    const [branch] = (await http().get('/api/branches').auth(s.owner.token, bearer)).body;
    const service = (await http().post('/api/services').auth(s.owner.token, bearer).send({ name: 'Consulta', durationMinutes: 30, price: 8000 }).expect(201)).body;
    const pro = (
      await http()
        .post('/api/professionals')
        .auth(s.owner.token, bearer)
        .send({ displayName: 'Dra. Vega', branchIds: [branch.id], services: [{ serviceId: service.id }], membershipId })
        .expect(201)
    ).body;
    await http()
      .put(`/api/professionals/${pro.id}/schedule`)
      .auth(s.owner.token, bearer)
      .send({ branchId: branch.id, days: [{ weekday: 1, intervals: [{ start: 9 * 60, end: 18 * 60 }] }] })
      .expect(200);
    await http()
      .post('/api/appointments')
      .auth(s.owner.token, bearer)
      .send({ branchId: branch.id, serviceId: service.id, professionalId: pro.id, clientId: s.clientId, startsAt: nextMondayAt10() })
      .expect(201);

    const mine = await write(member, s.clientId, { templateId: s.templateId, values: { [s.reason]: 'Nota de la Dra.' } }).expect(201);
    expect(mine.body.professionalId).toBe(pro.id);

    const seen = (await http().get(`/api/clients/${s.clientId}/records`).auth(member.token, bearer).expect(200)).body;
    expect(seen.map((r: { id: string }) => r.id)).toEqual([mine.body.id]);
    const all = (await http().get(`/api/clients/${s.clientId}/records`).auth(s.owner.token, bearer).expect(200)).body;
    expect(all).toHaveLength(2);
    // El dueño no puede editar el borrador de otro.
    expect((await http().patch(`/api/records/${mine.body.id}`).auth(s.owner.token, bearer).send({ values: {} })).status).toBe(403);
  });

  it('recepción no ve fichas', async () => {
    const s = await setup();
    const reception = await sessionAsMember(ctx.app, s.orgId, 'receptionist');
    await http().get(`/api/clients/${s.clientId}/records`).auth(reception.token, bearer).expect(403);
  });
});

/** Lunes 10:00 de Lima, al menos una semana en el futuro, en ISO UTC. */
function nextMondayAt10(): string {
  const d = new Date(Date.now() - 5 * 3_600_000 + 7 * 86_400_000);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return new Date(Date.parse(`${d.toISOString().slice(0, 10)}T15:00:00Z`)).toISOString();
}
