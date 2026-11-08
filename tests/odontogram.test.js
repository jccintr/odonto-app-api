import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { withTenant } from '../src/db/tenant.js';
import { api, createClinic, createDentist, createPatient, createProcedure, setupUser } from './helpers/factories.js';

async function setup() {
  const admin = await setupUser();
  const patient = await createPatient(admin.clinic, { name: 'Ana Lima' });
  return { ...admin, patient };
}
const url = (c, suffix = '') => `/api/patients/${c.patient.id}/odontogram${suffix}`;
const mark = (headers, c, body) => api().post(url(c)).set(headers).send(body);

describe('camada planejado', () => {
  async function setup() {
    const admin = await setupUser();
    return {
      ...admin, patient: await createPatient(admin.clinic, { name: 'Ana Lima' }), dentist: await createDentist(admin.clinic, { name: 'Dr. Paulo' }),
      procedure: await createProcedure(admin.clinic, { name: 'Restauração', price_cents: 20000 }),
    };
  }
  async function budget(c, items, { approve = [], status } = {}) {
    const res = await api().post('/api/budgets').set(c.headers).send({ patientId: c.patient.id, dentistId: c.dentist.dentist.id, items });
    if (approve.length) await api().post(`/api/budgets/${res.body.id}/approvals`).set(c.headers).send({ itemIds: approve.map((i) => res.body.items[i].id) });
    if (status) await api().post(`/api/budgets/${res.body.id}/status`).set(c.headers).send({ status });
    return res.body;
  }

  it('mostra por dente o que está proposto e o que já foi aprovado, sem valores; itens sem dente ficam de fora', async () => {
    const c = await setup();
    const b = await budget(c, [
      { procedureId: c.procedure.id, tooth: 16, faces: 'O' }, { procedureId: c.procedure.id, tooth: 16 }, { procedureId: c.procedure.id, tooth: 26 }, { procedureId: c.procedure.id },
    ], { approve: [0] });
    const { planned } = (await api().get(url(c)).set(c.headers)).body;
    expect(Object.keys(planned)).toEqual(['16', '26']);
    expect(planned['16']).toEqual([
      { itemId: b.items[0].id, procedure: { id: c.procedure.id, name: expect.any(String) }, faces: 'O', approved: true },
      { itemId: b.items[1].id, procedure: { id: c.procedure.id, name: expect.any(String) }, faces: null, approved: false },
    ]);
    expect(planned['26'][0].approved).toBe(false);
    expect(JSON.stringify(planned)).not.toContain('price');
  });

  it('recusado, executado ou cancelado saem do planejado', async () => {
    const c = await setup();
    await budget(c, [{ procedureId: c.procedure.id, tooth: 11 }], { status: 'rejected' });
    const b = await budget(c, [{ procedureId: c.procedure.id, tooth: 12 }, { procedureId: c.procedure.id, tooth: 13 }], { approve: [0, 1] });
    await api().post(`/api/budgets/${b.id}/items/${b.items[1].id}/cancel`).set(c.headers);
    expect(Object.keys((await api().get(url(c)).set(c.headers)).body.planned)).toEqual(['12']);
  });
});

describe('POST /api/patients/:id/odontogram', () => {
  it('registra uma marcação (faces na ordem canônica; data padrão = hoje) e audita', async () => {
    const c = await setup();
    const res = await mark(c.headers, c, { tooth: 16, faces: 'dom', condition: 'caries', notes: 'Cárie profunda' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ tooth: 16, faces: 'MDO', condition: 'caries', notes: 'Cárie profunda', recordedBy: c.user.id, sourceItemId: null });
    expect(res.body.recordedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const audit = await db('audit_log').where({ entity: 'tooth_record', entity_id: res.body.id });
    expect(audit.map((a) => a.action)).toEqual(['create']);
  });

  it('aceita dente de leite, data informada e marcação sem faces', async () => {
    const c = await setup();
    const res = await mark(c.headers, c, { tooth: 55, condition: 'extracted', recordedOn: '2026-10-01' });
    expect(res.body).toMatchObject({ tooth: 55, faces: null, notes: null, recordedOn: '2026-10-01' });
  });

  it('o dentista marca; secretária não (403); sem login (401)', async () => {
    const c = await setup();
    const dentist = await setupUser({ role: 'dentist', clinic: c.clinic });
    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });
    expect((await mark(dentist.headers, c, { tooth: 11, condition: 'crown' })).status).toBe(201);
    expect((await mark(secretary.headers, c, { tooth: 11, condition: 'crown' })).status).toBe(403);
    expect((await api().post(url(c)).send({})).status).toBe(401);
  });

  it('paciente de outra clínica ou inexistente: 404; id inválido: 400', async () => {
    const c = await setup();
    const foreign = await createPatient(await createClinic());
    expect((await api().post(`/api/patients/${foreign.id}/odontogram`).set(c.headers).send({ tooth: 11, condition: 'crown' })).status).toBe(404);
    expect((await api().post('/api/patients/00000000-0000-4000-8000-000000000000/odontogram').set(c.headers).send({ tooth: 11, condition: 'crown' })).status).toBe(404);
    expect((await api().post('/api/patients/abc/odontogram').set(c.headers).send({ tooth: 11, condition: 'crown' })).status).toBe(400);
  });

  it('valida o corpo (400)', async () => {
    const c = await setup();
    const bad = [{}, { tooth: 10, condition: 'caries' }, { tooth: 16 }, { tooth: 16, condition: 'dor' }, { tooth: 16, condition: 'caries', faces: 'X' },
      { tooth: 16, condition: 'caries', notes: 'x'.repeat(501) }, { tooth: 16, condition: 'caries', recordedOn: '01/10/2026' }];
    for (const body of bad) expect((await mark(c.headers, c, body)).status, JSON.stringify(body)).toBe(400);
  });
});

describe('GET /api/patients/:id/odontogram', () => {
  it('sem marcações: vazio; a leitura é auditada; todos os perfis consultam (inclusive a secretária)', async () => {
    const c = await setup();
    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });
    const res = await api().get(url(c)).set(secretary.headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ patientId: c.patient.id, teeth: {}, planned: {} });

    const audit = await db('audit_log').where({ entity: 'odontogram', entity_id: c.patient.id });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'read', user_id: secretary.user.id });
  });

  it('agrupa por dente, em ordem de data, e esconde marcações removidas', async () => {
    const c = await setup();
    await mark(c.headers, c, { tooth: 26, condition: 'restoration', recordedOn: '2026-09-01' });
    await mark(c.headers, c, { tooth: 16, condition: 'caries', recordedOn: '2026-10-01' });
    await mark(c.headers, c, { tooth: 16, condition: 'restoration', recordedOn: '2026-08-01' });
    const removed = (await mark(c.headers, c, { tooth: 36, condition: 'missing' })).body;
    await api().delete(url(c, `/${removed.id}`)).set(c.headers);

    const res = await api().get(url(c)).set(c.headers);
    expect(Object.keys(res.body.teeth)).toEqual(['16', '26']);
    expect(res.body.teeth['16'].map((r) => [r.condition, r.recordedOn])).toEqual([['restoration', '2026-08-01'], ['caries', '2026-10-01']]);
    expect(res.body.teeth['26']).toHaveLength(1);
  });

  it('não mistura pacientes nem clínicas; 404 para paciente de outra clínica ou inexistente; 400 para id inválido', async () => {
    const c = await setup();
    const otherPatient = await createPatient(c.clinic);
    await api().post(`/api/patients/${otherPatient.id}/odontogram`).set(c.headers).send({ tooth: 11, condition: 'crown' });
    expect((await api().get(url(c)).set(c.headers)).body.teeth).toEqual({});

    const foreign = await setup();
    expect((await api().get(url(foreign)).set(c.headers)).status).toBe(404);
    expect((await api().get('/api/patients/00000000-0000-4000-8000-000000000000/odontogram').set(c.headers)).status).toBe(404);
    expect((await api().get('/api/patients/abc/odontogram').set(c.headers)).status).toBe(400);
    expect((await api().get(url(c))).status).toBe(401);
  });
});

describe('DELETE /api/patients/:id/odontogram/:recordId', () => {
  it('remove de forma lógica: some da consulta, fica no banco com quem removeu, e audita', async () => {
    const c = await setup();
    const record = (await mark(c.headers, c, { tooth: 16, condition: 'caries' })).body;
    expect((await api().delete(url(c, `/${record.id}`)).set(c.headers)).status).toBe(204);

    const row = await db('tooth_records').where({ id: record.id }).first();
    expect(row.removed_at).not.toBeNull();
    expect(row.removed_by).toBe(c.user.id);
    expect((await api().get(url(c)).set(c.headers)).body.teeth).toEqual({});
    expect((await db('audit_log').where({ entity_id: record.id }).orderBy('created_at')).map((a) => a.action)).toEqual(['create', 'remove']);
  });

  it('remover de novo, marcação de outro paciente ou de outra clínica: 404; secretária 403; id inválido 400', async () => {
    const c = await setup();
    const record = (await mark(c.headers, c, { tooth: 16, condition: 'caries' })).body;
    const otherPatient = await createPatient(c.clinic);
    const foreign = await setup();
    const foreignRecord = (await mark(foreign.headers, foreign, { tooth: 16, condition: 'caries' })).body;
    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });

    expect((await api().delete(url(c, `/${record.id}`)).set(secretary.headers)).status).toBe(403);
    expect((await api().delete(`/api/patients/${otherPatient.id}/odontogram/${record.id}`).set(c.headers)).status).toBe(404);
    expect((await api().delete(url(c, `/${foreignRecord.id}`)).set(c.headers)).status).toBe(404);
    expect((await api().delete(url(c, `/${record.id}`)).set(c.headers)).status).toBe(204);
    expect((await api().delete(url(c, `/${record.id}`)).set(c.headers)).status).toBe(404);
    expect((await api().delete(url(c, '/abc')).set(c.headers)).status).toBe(400);
  });

  it('cada clínica só enxerga as próprias marcações no banco', async () => {
    const a = await setup();
    const b = await setup();
    await mark(a.headers, a, { tooth: 16, condition: 'caries' });
    expect(await withTenant(b.clinic.id, (trx) => trx('tooth_records'))).toHaveLength(0);
    expect(await withTenant(a.clinic.id, (trx) => trx('tooth_records'))).toHaveLength(1);
    expect(await createDentist(a.clinic)).toBeTruthy();
  });
});
