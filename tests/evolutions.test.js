import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { api, bearer, createDentist, createPatient, createProcedure, loginAs, setupUser } from './helpers/factories.js';

const T = (h, m = 0) => `2099-11-03T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
const dentistHeaders = async (user) => bearer((await loginAs(user)).accessToken);
const status = (headers, id, body) => api().post(`/api/appointments/${id}/status`).set(headers).send(body);
// inicia e conclui: quem não pode iniciar (ou já iniciou) recebe a resposta do início
const attend = async (headers, id, evolution) => {
  const current = (await api().get(`/api/appointments/${id}`).set(headers)).body.status;
  if (current !== 'in_progress') {
    const started = await status(headers, id, { status: 'in_progress' });
    if (started.status !== 200) return started;
  }
  return status(headers, id, { status: 'attended', evolution });
};
const records = (headers, patientId, query = '') => api().get(`/api/patients/${patientId}/evolutions${query}`).set(headers);

async function setup() {
  const admin = await setupUser();
  const secretary = await setupUser({ role: 'secretary', clinic: admin.clinic });
  const dentist = await createDentist(admin.clinic, { name: 'Dr. Paulo' });
  const patient = await createPatient(admin.clinic, { name: 'Ana Lima', phone: '35999990001' });
  const procedure = await createProcedure(admin.clinic, { name: 'Restauração', price_cents: 15000, odontogram_condition: 'restoration' });
  const headers = await dentistHeaders(dentist.user);
  const book = async (h = 9, extra = {}) =>
    (await api().post('/api/appointments').set(admin.headers).send({ patientId: patient.id, dentistId: dentist.dentist.id, startsAt: T(h), endsAt: T(h + 1), ...extra })).body;
  return { admin, secretary, dentist, patient, procedure, headers, book };
}

describe('marcar como atendido (POST /api/appointments/:id/status)', () => {
  const where = (c, extra = {}) => ({ procedureId: c.procedure.id, teeth: [16], ...extra });

  it('exige o procedimento e os dentes afetados: sem isso, 400 e nada muda', async () => {
    const c = await setup();
    const a = await c.book();
    const p = c.procedure.id;
    const bad = [
      undefined, {}, { description: 'Revisão geral feita' }, { procedures: [] }, { procedures: [{ procedureId: p }] }, { procedures: [{ procedureId: p, teeth: [] }] },
      { procedures: [{ procedureId: p, teeth: [99] }] }, { procedures: [{ procedureId: p, teeth: [16], wholeMouth: true }] }, { procedures: [{ procedureId: p, wholeMouth: false }] },
      { description: 'ok', procedures: [{ procedureId: p, teeth: [16] }] }, { description: 'x'.repeat(5001), procedures: [{ procedureId: p, teeth: [16] }] },
      { budgetItems: [{ itemId: p, teeth: [16], wholeMouth: true }] },
    ];
    for (const evolution of bad) expect((await status(c.headers, a.id, { status: 'attended', evolution })).status, JSON.stringify(evolution)).toBe(400);
    expect((await api().get(`/api/appointments/${a.id}`).set(c.headers)).body.status).toBe('scheduled');
  });

  it('a evolução só vale ao marcar como atendido (400 nas demais situações)', async () => {
    const c = await setup();
    const a = await c.book();
    expect((await status(c.headers, a.id, { status: 'confirmed', evolution: { procedures: [where(c)] } })).status).toBe(400);
  });

  it('só o dentista marca como atendido: administração e secretária recebem 403 e nada muda', async () => {
    const c = await setup();
    const a = await c.book();
    for (const who of [c.admin, c.secretary]) {
      expect((await attend(who.headers, a.id, { procedures: [where(c)] })).status).toBe(403);
    }
    expect((await api().get(`/api/appointments/${a.id}`).set(c.admin.headers)).body.status).toBe('scheduled');
    expect(await db('evolutions').count({ n: '*' }).first()).toMatchObject({ n: '0' });
  });

  it('registra um procedimento por dente afetado (ou boca toda), com texto opcional', async () => {
    const c = await setup();
    const cleaning = await createProcedure(c.admin.clinic, { name: 'Limpeza' });
    const a = await c.book();
    const res = await attend(c.headers, a.id, {
      description: 'Restauração em resina, sem intercorrências.',
      procedures: [{ procedureId: c.procedure.id, teeth: [26, 27, 26] }, { procedureId: cleaning.id, wholeMouth: true }],
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('attended');

    const list = (await records(c.headers, c.patient.id)).body;
    expect(list.total).toBe(1);
    expect(list.data[0]).toMatchObject({
      appointmentId: a.id, appointmentStartsAt: T(9), dentist: { id: c.dentist.dentist.id, name: 'Dr. Paulo' },
      description: 'Restauração em resina, sem intercorrências.', addenda: [],
    });
    const found = list.data[0].procedures.map((p) => [p.procedure.name, p.tooth, p.wholeMouth]).sort((x, y) => (x[1] ?? 0) - (y[1] ?? 0));
    expect(found).toEqual([['Limpeza', null, true], ['Restauração', 26, false], ['Restauração', 27, false]]); // dente repetido entra uma vez só
  });

  it('só os procedimentos bastam (o texto é opcional)', async () => {
    const c = await setup();
    const [a, b] = [await c.book(9), await c.book(11)];
    expect((await attend(c.headers, a.id, { procedures: [where(c)] })).status).toBe(200);
    expect((await attend(c.headers, b.id, { procedures: [{ procedureId: c.procedure.id, wholeMouth: true }] })).status).toBe(200);
    const list = (await records(c.headers, c.patient.id)).body;
    expect(list.total).toBe(2);
    expect(list.data.every((e) => e.description === null)).toBe(true);
  });

  it('dá baixa em item de orçamento aprovado: usa o dente do item (e marca o odontograma)', async () => {
    const c = await setup();
    const a = await c.book();
    const budget = (await api().post('/api/budgets').set(c.headers).send({ patientId: c.patient.id, items: [{ procedureId: c.procedure.id, tooth: 16 }] })).body;
    await api().post(`/api/budgets/${budget.id}/status`).set(c.admin.headers).send({ status: 'approved' });

    const res = await attend(c.headers, a.id, { budgetItems: [{ itemId: budget.items[0].id }], procedures: [where(c, { teeth: [26] })] });
    expect(res.status).toBe(200);
    const found = (await records(c.headers, c.patient.id)).body.data[0].procedures.map((p) => [p.tooth, p.budgetItemId]).sort((x, y) => x[0] - y[0]);
    expect(found).toEqual([[16, budget.items[0].id], [26, null]]);
    expect((await api().get(`/api/budgets/${budget.id}`).set(c.headers)).body.status).toBe('completed');
    expect((await api().get(`/api/patients/${c.patient.id}/odontogram`).set(c.headers)).body.teeth[16]).toHaveLength(1);
  });

  it('item de orçamento sem dente: o dentista informa onde foi feito (dentes ou boca toda); item com dente não aceita outro', async () => {
    const c = await setup();
    const [a, b] = [await c.book(9), await c.book(11)];
    const budget = (await api().post('/api/budgets').set(c.headers).send({
      patientId: c.patient.id, items: [{ procedureId: c.procedure.id }, { procedureId: c.procedure.id }, { procedureId: c.procedure.id, tooth: 36 }],
    })).body;
    await api().post(`/api/budgets/${budget.id}/status`).set(c.admin.headers).send({ status: 'approved' });
    const [free1, free2, fixed] = budget.items;

    const missing = await attend(c.headers, a.id, { budgetItems: [{ itemId: free1.id }] });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('TEETH_REQUIRED');
    expect((await attend(c.headers, a.id, { budgetItems: [{ itemId: fixed.id, teeth: [37] }] })).status).toBe(422);
    expect((await api().get(`/api/appointments/${a.id}`).set(c.admin.headers)).body.status).toBe('in_progress');

    expect((await attend(c.headers, a.id, { budgetItems: [{ itemId: free1.id, teeth: [11, 12] }] })).status).toBe(200);
    expect((await attend(c.headers, b.id, { budgetItems: [{ itemId: free2.id, wholeMouth: true }] })).status).toBe(200);
    const data = (await records(c.headers, c.patient.id)).body.data;
    expect(data.flatMap((e) => e.procedures).map((p) => [p.tooth, p.wholeMouth]).sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0))).toEqual([[null, true], [11, false], [12, false]]);
  });

  it('tudo ou nada: procedimento inexistente, desativado ou item inválido desfaz o atendimento', async () => {
    const c = await setup();
    const off = await createProcedure(c.admin.clinic, { name: 'Antigo', active: false });
    const a = await c.book();
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await attend(c.headers, a.id, { procedures: [where(c, { procedureId: missing })] })).status).toBe(404);
    expect((await attend(c.headers, a.id, { procedures: [where(c, { procedureId: off.id })] })).status).toBe(422);
    expect((await attend(c.headers, a.id, { budgetItems: [{ itemId: missing, teeth: [16] }] })).status).toBe(404);

    // orçamento em aberto (não aprovado) e item de outro paciente
    const budget = (await api().post('/api/budgets').set(c.headers).send({ patientId: c.patient.id, items: [{ procedureId: c.procedure.id, tooth: 16 }] })).body;
    const open = await attend(c.headers, a.id, { budgetItems: [{ itemId: budget.items[0].id }] });
    expect(open.status).toBe(409);
    expect(open.body.code).toBe('BUDGET_NOT_APPROVED');
    const other = await createPatient(c.admin.clinic, { name: 'Bia Costa' });
    const foreign = (await api().post('/api/budgets').set(c.headers).send({ patientId: other.id, items: [{ procedureId: c.procedure.id }] })).body;
    expect((await attend(c.headers, a.id, { budgetItems: [{ itemId: foreign.items[0].id, teeth: [16] }] })).status).toBe(404);

    expect((await api().get(`/api/appointments/${a.id}`).set(c.admin.headers)).body.status).toBe('in_progress');
    expect((await records(c.headers, c.patient.id)).body.total).toBe(0);
  });

  it('item de orçamento já finalizado não recebe baixa de novo (409 ITEM_NOT_PENDING)', async () => {
    const c = await setup();
    const [a, b] = [await c.book(9), await c.book(11)];
    const budget = (await api().post('/api/budgets').set(c.headers).send({ patientId: c.patient.id, items: [{ procedureId: c.procedure.id, tooth: 16 }, { procedureId: c.procedure.id, tooth: 17 }] })).body;
    await api().post(`/api/budgets/${budget.id}/status`).set(c.admin.headers).send({ status: 'approved' });
    expect((await attend(c.headers, a.id, { budgetItems: [{ itemId: budget.items[0].id }] })).status).toBe(200);
    const again = await attend(c.headers, b.id, { budgetItems: [{ itemId: budget.items[0].id }] });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ITEM_NOT_PENDING');
  });

  it('um atendimento só vira atendido uma vez (a evolução não duplica)', async () => {
    const c = await setup();
    const a = await c.book();
    await attend(c.headers, a.id, { procedures: [where(c)] });
    expect((await attend(c.headers, a.id, { procedures: [where(c)] })).status).toBe(409);
    expect((await records(c.headers, c.patient.id)).body.total).toBe(1);
  });

  it('o banco recusa uma segunda evolução do mesmo atendimento, "boca toda" com dente e qualquer alteração ou exclusão do registro', async () => {
    const c = await setup();
    const a = await c.book();
    await attend(c.headers, a.id, { procedures: [where(c)] });
    const row = await db('evolutions').first();
    const dup = { clinic_id: row.clinic_id, patient_id: row.patient_id, dentist_id: row.dentist_id, appointment_id: a.id, kind: 'evolution', created_by: row.created_by };
    await expect(db('evolutions').insert(dup)).rejects.toThrow(/duplicate key/);
    await expect(db('evolutions').insert({ ...dup, appointment_id: null })).rejects.toThrow(/kind_check/);
    await expect(db('evolution_items').insert({ clinic_id: row.clinic_id, evolution_id: row.id, procedure_id: c.procedure.id, procedure_name: 'x', tooth: 16, whole_mouth: true })).rejects.toThrow(/where_check/);
    // a aplicação só acrescenta: sem permissão de UPDATE/DELETE para o papel da aplicação
    const grants = (await db.raw("SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'evolutions' AND grantee = 'odonto_app'")).rows.map((r) => r.privilege_type).sort();
    expect(grants).toEqual(['INSERT', 'SELECT']);
  });
});

describe('GET /api/patients/:patientId/evolutions', () => {
  it('lista da mais recente para a mais antiga, com paginação; administração e dentistas leem, secretária não (403)', async () => {
    const c = await setup();
    const other = await createDentist(c.admin.clinic, { name: 'Dra. Bia' });
    for (const h of [9, 11, 13]) await attend(c.headers, (await c.book(h)).id, { description: `Atendimento das ${h}h`, procedures: [{ procedureId: c.procedure.id, teeth: [16] }] });
    const asAdmin = (await records(c.admin.headers, c.patient.id, '?perPage=2')).body;
    expect(asAdmin).toMatchObject({ page: 1, perPage: 2, total: 3, totalPages: 2 });
    expect(asAdmin.data.map((e) => e.description)).toEqual(['Atendimento das 13h', 'Atendimento das 11h']);
    expect((await records(c.admin.headers, c.patient.id, '?perPage=2&page=2')).body.data.map((e) => e.description)).toEqual(['Atendimento das 9h']);
    // outro dentista da clínica também lê o histórico do paciente, mas não pode retificar os registros dos outros
    const asOther = (await records(await dentistHeaders(other.user), c.patient.id)).body;
    expect(asOther.total).toBe(3);
    expect(asOther.data.some((e) => e.canAmend)).toBe(false);
    expect(asAdmin.data.some((e) => e.canAmend)).toBe(false);
    expect((await records(c.headers, c.patient.id)).body.data.every((e) => e.canAmend)).toBe(true);
    expect((await records(c.secretary.headers, c.patient.id)).status).toBe(403);
  });

  it('404 para paciente inexistente ou de outra clínica; a leitura fica na auditoria', async () => {
    const c = await setup();
    const foreign = await setup();
    expect((await records(c.headers, foreign.patient.id)).status).toBe(404);
    expect((await records(c.headers, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await records(c.headers, 'abc')).status).toBe(400);
    await records(c.headers, c.patient.id);
    expect(await db('audit_log').where({ entity: 'patient', entity_id: c.patient.id, action: 'read' }).count({ n: '*' }).first()).toMatchObject({ n: '1' });
  });
});

describe('POST /api/patients/:patientId/evolutions/:id/addendum (retificação)', () => {
  const addendum = (headers, patientId, id, body) => api().post(`/api/patients/${patientId}/evolutions/${id}/addendum`).set(headers).send(body);

  it('o dentista autor acrescenta uma retificação; o original não muda e a correção aparece junto dele', async () => {
    const c = await setup();
    await attend(c.headers, (await c.book()).id, { description: 'Restauração no 16', procedures: [{ procedureId: c.procedure.id, teeth: [16] }] });
    const original = (await records(c.headers, c.patient.id)).body.data[0];

    const res = await addendum(c.headers, c.patient.id, original.id, { description: 'Correção: o dente era o 26.' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ evolutionId: original.id, dentist: { id: c.dentist.dentist.id, name: 'Dr. Paulo' }, description: 'Correção: o dente era o 26.' });

    const after = (await records(c.admin.headers, c.patient.id)).body;
    expect(after.total).toBe(1); // a retificação não conta como atendimento
    expect(after.data[0]).toMatchObject({ id: original.id, description: 'Restauração no 16' });
    expect(after.data[0].addenda).toHaveLength(1);
    expect(after.data[0].addenda[0].description).toBe('Correção: o dente era o 26.');
  });

  it('outro dentista, administração e secretária não retificam (403); valida o texto (400); 404 para evolução alheia', async () => {
    const c = await setup();
    const other = await createDentist(c.admin.clinic, { name: 'Dra. Bia' });
    const foreign = await setup();
    await attend(c.headers, (await c.book()).id, { description: 'Restauração no 16', procedures: [{ procedureId: c.procedure.id, teeth: [16] }] });
    const original = (await records(c.headers, c.patient.id)).body.data[0];

    expect((await addendum(await dentistHeaders(other.user), c.patient.id, original.id, { description: 'Tentativa' })).status).toBe(403);
    for (const who of [c.admin, c.secretary]) expect((await addendum(who.headers, c.patient.id, original.id, { description: 'Tentativa' })).status).toBe(403);
    for (const bad of [{}, { description: 'ok' }, { description: 'x'.repeat(5001) }]) expect((await addendum(c.headers, c.patient.id, original.id, bad)).status).toBe(400);
    expect((await addendum(c.headers, c.patient.id, '00000000-0000-4000-8000-000000000000', { description: 'Tentativa' })).status).toBe(404);
    expect((await addendum(c.headers, foreign.patient.id, original.id, { description: 'Tentativa' })).status).toBe(404);
    // não se retifica uma retificação
    const first = (await addendum(c.headers, c.patient.id, original.id, { description: 'Primeira correção' })).body;
    expect((await addendum(c.headers, c.patient.id, first.id, { description: 'Segunda correção' })).status).toBe(404);
    expect((await records(c.headers, c.patient.id)).body.data[0].addenda).toHaveLength(1);
  });
});
