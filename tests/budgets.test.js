import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { api, bearer, createClinic, createDentist, createPatient, createProcedure, loginAs, setupUser } from './helpers/factories.js';

async function setup() {
  const admin = await setupUser();
  const dentist = await createDentist(admin.clinic, { name: 'Dr. Paulo' });
  const patient = await createPatient(admin.clinic, { name: 'Ana Lima' });
  const cleaning = await createProcedure(admin.clinic, { name: 'Limpeza', price_cents: 15000 });
  const filling = await createProcedure(admin.clinic, { name: 'Restauração', price_cents: 20000, odontogram_condition: 'restoration' });
  const canal = await createProcedure(admin.clinic, { name: 'Canal', price_cents: 60000, odontogram_condition: 'root_canal' });
  return { ...admin, dentist, patient, cleaning, filling, canal };
}
const dentistHeaders = async (user) => bearer((await loginAs(user)).accessToken);
const make = (c, body = {}) => api().post('/api/budgets').set(c.headers).send({
  patientId: c.patient.id, dentistId: c.dentist.dentist.id, items: [{ procedureId: c.cleaning.id }, { procedureId: c.filling.id, tooth: 16, faces: 'OD' }], ...body,
});
const approved = async (c, body) => {
  const budget = (await make(c, body)).body;
  await api().post(`/api/budgets/${budget.id}/status`).set(c.headers).send({ status: 'approved' });
  return budget;
};

describe('POST /api/budgets', () => {
  it('cria o orçamento com itens (preço sempre o da tabela da clínica) e calcula os totais', async () => {
    const c = await setup();
    const res = await make(c, { discountCents: 5000, notes: 'Plano completo', items: [
      { procedureId: c.cleaning.id },
      { procedureId: c.filling.id, tooth: 16, faces: 'dom' },
      { procedureId: c.canal.id, tooth: 26, priceCents: 1 }, // o preço enviado é ignorado: vale o da tabela
    ] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'open', notes: 'Plano completo', itemsCount: 3, subtotalCents: 95000, discountCents: 5000, totalCents: 90000, approvedAt: null,
      patient: { id: c.patient.id, name: 'Ana Lima' }, dentist: { id: c.dentist.dentist.id, name: 'Dr. Paulo' },
    });
    expect(res.body.items.map((i) => [i.procedure.name, i.tooth, i.faces, i.priceCents, i.status, i.position])).toEqual([
      ['Limpeza', null, null, 15000, 'pending', 1],
      ['Restauração', 16, 'MDO', 20000, 'pending', 2],
      ['Canal', 26, null, 60000, 'pending', 3],
    ]);
  });

  it('o dentista cria na própria carteira (o dentistId é opcional para ele) e não na de outro (403)', async () => {
    const c = await setup();
    const other = await createDentist(c.clinic);
    const headers = await dentistHeaders(c.dentist.user);
    const body = { patientId: c.patient.id, items: [{ procedureId: c.cleaning.id }] };

    const own = await api().post('/api/budgets').set(headers).send(body);
    expect(own.status).toBe(201);
    expect(own.body.dentist.id).toBe(c.dentist.dentist.id);
    expect((await api().post('/api/budgets').set(headers).send({ ...body, dentistId: c.dentist.dentist.id })).status).toBe(201);
    expect((await api().post('/api/budgets').set(headers).send({ ...body, dentistId: other.dentist.id })).status).toBe(403);
  });

  it('administrador precisa informar o dentista (400); secretária não cria (403)', async () => {
    const c = await setup();
    const res = await api().post('/api/budgets').set(c.headers).send({ patientId: c.patient.id, items: [{ procedureId: c.cleaning.id }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Informe o dentista.');

    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });
    expect((await api().post('/api/budgets').set(secretary.headers).send({})).status).toBe(403);
  });

  it('paciente, dentista ou procedimento inexistentes ou de outra clínica: 404; arquivado, desativado ou desconto maior que o valor: 422', async () => {
    const c = await setup();
    const foreign = await setup();
    const missing = '00000000-0000-4000-8000-000000000000';

    expect((await make(c, { patientId: foreign.patient.id })).status).toBe(404);
    expect((await make(c, { patientId: missing })).status).toBe(404);
    expect((await make(c, { dentistId: foreign.dentist.dentist.id })).status).toBe(404);
    expect((await make(c, { items: [{ procedureId: foreign.cleaning.id }] })).status).toBe(404);
    expect((await make(c, { items: [{ procedureId: missing }] })).status).toBe(404);

    expect((await make(c, { discountCents: 99999 })).status).toBe(422);
    await db('procedures').where({ id: c.cleaning.id }).update({ active: false });
    const inactive = await make(c);
    expect(inactive.status).toBe(422);
    expect(inactive.body.error).toContain('Limpeza');
    await db('procedures').where({ id: c.cleaning.id }).update({ active: true });

    await db('patients').where({ id: c.patient.id }).update({ active: false });
    expect((await make(c)).status).toBe(422);
    await db('patients').where({ id: c.patient.id }).update({ active: true });
    await db('users').where({ id: c.dentist.user.id }).update({ active: false });
    expect((await make(c)).status).toBe(422);
    expect(await db('budgets')).toHaveLength(0);
  });

  it('valida o corpo (400): itens, dente, faces, valores e ids', async () => {
    const c = await setup();
    const item = (extra) => ({ items: [{ procedureId: c.cleaning.id, ...extra }] });
    const bad = [
      { items: [] }, { items: undefined }, { items: Array.from({ length: 101 }, () => ({ procedureId: c.cleaning.id })) },
      item({ tooth: 10 }), item({ tooth: 99 }), item({ tooth: 11.5 }), item({ tooth: '16' }), item({ faces: 'O' }), item({ tooth: 16, faces: 'X' }),
      item({ procedureId: 'abc' }),
      { discountCents: -1 }, { discountCents: 1.5 }, { patientId: 'abc' }, { notes: 'x'.repeat(2001) },
    ];
    for (const extra of bad) expect((await make(c, extra)).status, JSON.stringify(extra).slice(0, 80)).toBe(400);
  });

  it('o banco recusa dados inválidos mesmo sem passar pela API (FK composta e CHECKs)', async () => {
    const c = await setup();
    const foreign = await setup();
    const base = { clinic_id: c.clinic.id, dentist_id: c.dentist.dentist.id };
    await expect(db('budgets').insert({ ...base, patient_id: foreign.patient.id })).rejects.toThrow(/foreign key/);

    const budget = (await make(c)).body;
    const item = { clinic_id: c.clinic.id, budget_id: budget.id, procedure_id: c.cleaning.id, price_cents: 100 };
    await expect(db('budget_items').insert({ ...item, procedure_id: foreign.cleaning.id })).rejects.toThrow(/foreign key/);
    await expect(db('budget_items').insert({ ...item, tooth: 10 })).rejects.toThrow(/tooth_check/);
    await expect(db('budget_items').insert({ ...item, faces: 'V' })).rejects.toThrow(/faces_tooth_check/);
    await expect(db('budget_items').insert({ ...item, tooth: 11, faces: 'Z' })).rejects.toThrow(/faces_check/);
    await expect(db('budget_items').insert({ ...item, status: 'done' })).rejects.toThrow(/done_check/);
  });
});

describe('GET /api/budgets', () => {
  async function seed() {
    const c = await setup();
    const d2 = await createDentist(c.clinic, { name: 'Dra. Bia' });
    const p2 = await createPatient(c.clinic, { name: 'Bruno Costa' });
    const a = (await make(c)).body;
    const b = (await make(c, { patientId: p2.id, dentistId: d2.dentist.id })).body;
    await api().post(`/api/budgets/${b.id}/status`).set(c.headers).send({ status: 'approved' });
    const foreign = await setup();
    await make(foreign);
    return { ...c, d2, p2, a, b };
  }
  const ids = async (headers, qs = '') => (await api().get(`/api/budgets?${qs}`).set(headers)).body.data.map((x) => x.id);

  it('lista só a própria clínica, do mais novo para o mais antigo, em formato resumido', async () => {
    const c = await seed();
    const res = await api().get('/api/budgets').set(c.headers);
    expect(res.body).toMatchObject({ page: 1, perPage: 20, total: 2, totalPages: 1 });
    expect(res.body.data.map((x) => x.id)).toEqual([c.b.id, c.a.id]);
    expect(res.body.data[0]).toMatchObject({ itemsCount: 2, subtotalCents: 35000, totalCents: 35000, status: 'approved' });
    expect(res.body.data[0]).not.toHaveProperty('items');
  });

  it('filtra por paciente, dentista e situação; pagina', async () => {
    const c = await seed();
    expect(await ids(c.headers, `patientId=${c.p2.id}`)).toEqual([c.b.id]);
    expect(await ids(c.headers, `dentistId=${c.dentist.dentist.id}`)).toEqual([c.a.id]);
    expect(await ids(c.headers, 'status=approved')).toEqual([c.b.id]);
    expect(await ids(c.headers, 'status=completed')).toEqual([]);
    const page = await api().get('/api/budgets?perPage=1&page=2').set(c.headers);
    expect(page.body).toMatchObject({ page: 2, perPage: 1, total: 2, totalPages: 2 });
    expect(page.body.data.map((x) => x.id)).toEqual([c.a.id]);
  });

  it('o dentista vê só os próprios orçamentos, mesmo filtrando por outro', async () => {
    const c = await seed();
    const own = await dentistHeaders(c.dentist.user);
    expect(await ids(own)).toEqual([c.a.id]);
    expect(await ids(own, `dentistId=${c.d2.dentist.id}`)).toEqual([c.a.id]);
  });

  it('valida a consulta (400) e exige login (401)', async () => {
    const c = await seed();
    for (const qs of ['status=x', 'patientId=abc', 'dentistId=abc', 'perPage=101', 'page=0']) {
      expect((await api().get(`/api/budgets?${qs}`).set(c.headers)).status, qs).toBe(400);
    }
    expect((await api().get('/api/budgets')).status).toBe(401);
  });
});

describe('GET /api/budgets/:id', () => {
  it('devolve o orçamento com os itens; 404 para outra clínica, de outro dentista (visão do dentista) ou inexistente; 400 para id inválido', async () => {
    const c = await setup();
    const other = await createDentist(c.clinic);
    const mine = (await make(c)).body;
    const theirs = (await make(c, { dentistId: other.dentist.id })).body;
    const foreign = await setup();
    const foreignBudget = (await make(foreign)).body;
    const get = (headers, id) => api().get(`/api/budgets/${id}`).set(headers);

    const res = await get(c.headers, mine.id);
    expect(res.body.items).toHaveLength(2);
    expect((await get(c.headers, foreignBudget.id)).status).toBe(404);
    expect((await get(c.headers, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await get(c.headers, 'abc')).status).toBe(400);
    const dentist = await dentistHeaders(c.dentist.user);
    expect((await get(dentist, mine.id)).status).toBe(200);
    expect((await get(dentist, theirs.id)).status).toBe(404);
    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });
    expect((await get(secretary.headers, theirs.id)).status).toBe(200);
  });
});

describe('PATCH /api/budgets/:id', () => {
  const patch = (headers, id, body) => api().patch(`/api/budgets/${id}`).set(headers).send(body);

  it('altera desconto e observações enquanto está em aberto', async () => {
    const c = await setup();
    const b = (await make(c)).body;
    const res = await patch(c.headers, b.id, { discountCents: 5000, notes: 'Combinado' });
    expect(res.body).toMatchObject({ discountCents: 5000, totalCents: 30000, notes: 'Combinado' });
    expect((await patch(c.headers, b.id, { notes: null })).body).toMatchObject({ notes: null, discountCents: 5000 });
  });

  it('desconto maior que o valor: 422; fora de "aberto": 409; corpo inválido: 400', async () => {
    const c = await setup();
    const b = (await make(c)).body;
    expect((await patch(c.headers, b.id, { discountCents: 35001 })).status).toBe(422);
    for (const bad of [{}, { discountCents: -1 }, { notes: 'x'.repeat(2001) }]) expect((await patch(c.headers, b.id, bad)).status).toBe(400);

    await api().post(`/api/budgets/${b.id}/status`).set(c.headers).send({ status: 'approved' });
    const locked = await patch(c.headers, b.id, { notes: 'tarde demais' });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('BUDGET_NOT_OPEN');
  });

  it('secretária não altera (403); dentista não mexe no orçamento de outro (404)', async () => {
    const c = await setup();
    const other = await createDentist(c.clinic);
    const theirs = (await make(c, { dentistId: other.dentist.id })).body;
    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });
    expect((await patch(secretary.headers, theirs.id, { notes: 'x' })).status).toBe(403);
    expect((await patch(await dentistHeaders(c.dentist.user), theirs.id, { notes: 'x' })).status).toBe(404);
  });
});

describe('itens do orçamento', () => {
  const item = (headers, id, itemId) => api().patch(`/api/budgets/${id}/items/${itemId}`).set(headers);
  const add = (headers, id, body) => api().post(`/api/budgets/${id}/items`).set(headers).send(body);

  it('inclui, altera e remove itens; a posição continua a sequência e os totais acompanham', async () => {
    const c = await setup();
    const b = (await make(c)).body;
    const added = await add(c.headers, b.id, { procedureId: c.canal.id, tooth: 36, faces: 'O' });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ itemsCount: 3, subtotalCents: 95000 });
    expect(added.body.items.at(-1)).toMatchObject({ position: 3, priceCents: 60000, tooth: 36, faces: 'O' });

    const target = added.body.items.at(-1);
    const changed = await item(c.headers, b.id, target.id).send({ tooth: 37, faces: 'od', priceCents: 1 });
    expect(changed.body.items.at(-1)).toMatchObject({ tooth: 37, faces: 'DO', priceCents: 60000 });
    expect(changed.body.subtotalCents).toBe(95000);

    const removed = await api().delete(`/api/budgets/${b.id}/items/${target.id}`).set(c.headers);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ itemsCount: 2, subtotalCents: 35000 });
  });

  it('esvaziar e incluir de novo recomeça a posição em 1', async () => {
    const c = await setup();
    const b = (await make(c, { items: [{ procedureId: c.cleaning.id }] })).body;
    await api().delete(`/api/budgets/${b.id}/items/${b.items[0].id}`).set(c.headers);
    const res = await add(c.headers, b.id, { procedureId: c.cleaning.id });
    expect(res.body.items.map((i) => i.position)).toEqual([1]);
  });

  it('limpar o dente (null) ou as faces; faces sem dente: 422', async () => {
    const c = await setup();
    const b = (await make(c)).body;
    const withTooth = b.items[1];
    expect((await item(c.headers, b.id, withTooth.id).send({ faces: null })).body.items[1]).toMatchObject({ tooth: 16, faces: null });
    expect((await item(c.headers, b.id, withTooth.id).send({ faces: 'V' })).status).toBe(200);
    const res = await item(c.headers, b.id, withTooth.id).send({ tooth: null });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Informe o dente para indicar as faces.');
    expect((await item(c.headers, b.id, withTooth.id).send({ tooth: null, faces: null })).body.items[1]).toMatchObject({ tooth: null, faces: null });
  });

  it('desconto maior que o novo valor: 422 ao remover item', async () => {
    const c = await setup();
    const b = (await make(c, { discountCents: 30000 })).body;
    expect((await api().delete(`/api/budgets/${b.id}/items/${b.items[1].id}`).set(c.headers)).status).toBe(422);
    expect((await api().get(`/api/budgets/${b.id}`).set(c.headers)).body.itemsCount).toBe(2);
  });

  it('só enquanto proposto (409 se já aprovado); item de outro orçamento ou inexistente: 404; secretária: 403', async () => {
    const c = await setup();
    const a = (await make(c)).body;
    const other = (await make(c)).body;
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await item(c.headers, a.id, other.items[0].id).send({ tooth: 11 })).status).toBe(404);
    expect((await api().delete(`/api/budgets/${a.id}/items/${missing}`).set(c.headers)).status).toBe(404);
    expect((await add(c.headers, a.id, { procedureId: missing })).status).toBe(404);

    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });
    expect((await add(secretary.headers, a.id, { procedureId: c.cleaning.id })).status).toBe(403);

    await api().post(`/api/budgets/${a.id}/status`).set(c.headers).send({ status: 'approved' });
    // em tratamento ainda se propõe procedimento novo, mas o que já foi aprovado não muda mais
    expect((await add(c.headers, a.id, { procedureId: c.cleaning.id })).status).toBe(201);
    const approved = a.items[0].id;
    expect((await item(c.headers, a.id, approved).send({ tooth: 11 })).body.code).toBe('ITEM_ALREADY_APPROVED');
    expect((await api().delete(`/api/budgets/${a.id}/items/${approved}`).set(c.headers)).body.code).toBe('ITEM_ALREADY_APPROVED');
    // recusado ou concluído: nada muda
    const rejected = (await make(c)).body;
    await api().post(`/api/budgets/${rejected.id}/status`).set(c.headers).send({ status: 'rejected' });
    expect((await add(c.headers, rejected.id, { procedureId: c.cleaning.id })).body.code).toBe('BUDGET_NOT_OPEN');
    expect((await item(c.headers, rejected.id, rejected.items[0].id).send({ tooth: 11 })).status).toBe(409);
    expect((await api().delete(`/api/budgets/${rejected.id}/items/${rejected.items[0].id}`).set(c.headers)).status).toBe(409);
  });

  it('valida o corpo (400)', async () => {
    const c = await setup();
    const b = (await make(c)).body;
    for (const bad of [{}, { procedureId: 'abc' }, { procedureId: c.cleaning.id, faces: 'O' }, { procedureId: c.cleaning.id, tooth: 10 }]) {
      expect((await add(c.headers, b.id, bad)).status).toBe(400);
    }
    for (const bad of [{}, { tooth: 10 }, { faces: 'X' }, { priceCents: 5 }]) expect((await item(c.headers, b.id, b.items[0].id).send(bad)).status).toBe(400);
  });
});

describe('POST /api/budgets/:id/status', () => {
  const status = (headers, id, s) => api().post(`/api/budgets/${id}/status`).set(headers).send({ status: s });

  it('aprova (registra a data), recusa e reabre; todos os perfis podem registrar a decisão', async () => {
    const c = await setup();
    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });
    const b = (await make(c)).body;
    const ok = await status(secretary.headers, b.id, 'approved');
    expect(ok.body.status).toBe('approved');
    expect(ok.body.approvedAt).toBeTruthy();

    const c2 = (await make(c)).body;
    expect((await status(c.headers, c2.id, 'rejected')).body.status).toBe('rejected');
    const reopened = await status(c.headers, c2.id, 'open');
    expect(reopened.body).toMatchObject({ status: 'open', approvedAt: null });
  });

  it('transições inválidas: 409 INVALID_TRANSITION; aprovar sem itens: 422; "completed" não é aceito (400)', async () => {
    const c = await setup();
    const b = (await make(c)).body;
    const same = await status(c.headers, b.id, 'open');
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('INVALID_TRANSITION');
    expect((await status(c.headers, b.id, 'completed')).status).toBe(400);
    expect((await status(c.headers, b.id, 'x')).status).toBe(400);

    await status(c.headers, b.id, 'approved');
    expect((await status(c.headers, b.id, 'open')).status).toBe(409);
    expect((await status(c.headers, b.id, 'rejected')).status).toBe(409);

    const empty = (await make(c, { items: [{ procedureId: c.cleaning.id }] })).body;
    await api().delete(`/api/budgets/${empty.id}/items/${empty.items[0].id}`).set(c.headers);
    expect((await status(c.headers, empty.id, 'approved')).status).toBe(422);
  });

  it('dentista não decide orçamento de outro (404); outra clínica: 404', async () => {
    const c = await setup();
    const other = await createDentist(c.clinic);
    const theirs = (await make(c, { dentistId: other.dentist.id })).body;
    expect((await status(await dentistHeaders(c.dentist.user), theirs.id, 'approved')).status).toBe(404);
    const foreign = await setup();
    expect((await status(foreign.headers, theirs.id, 'approved')).status).toBe(404);
    expect((await status(c.headers, 'abc', 'approved')).status).toBe(400);
  });
});
