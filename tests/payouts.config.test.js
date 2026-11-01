import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { api, setupUser } from './helpers/factories.js';
import { dentistPercent, rule, setup, settings } from './helpers/payouts.js';

describe('configuração do repasse', () => {
  it('sem nada salvo, devolve os padrões', async () => {
    const c = await setup();
    const res = await api().get('/api/payouts/settings').set(c.headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      releaseOn: 'payment', deductCosts: false, deductCardFees: false, creditCardFeePercent: 0, debitCardFeePercent: 0, defaultPercent: 0,
    });
  });

  it('altera só o que foi enviado e guarda para a próxima consulta', async () => {
    const c = await setup();
    await settings(c, { releaseOn: 'procedure', defaultPercent: 25.5 });
    const second = await settings(c, { deductCosts: true, creditCardFeePercent: 3.99 });
    expect(second).toEqual({
      releaseOn: 'procedure', deductCosts: true, deductCardFees: false, creditCardFeePercent: 3.99, debitCardFeePercent: 0, defaultPercent: 25.5,
    });
    expect((await api().get('/api/payouts/settings').set(c.headers)).body).toEqual(second);
    expect(await db('payout_settings').where({ clinic_id: c.clinic.id })).toHaveLength(1);
  });

  it('cada clínica tem a sua configuração', async () => {
    const a = await setup();
    const b = await setupUser();
    await settings(a, { defaultPercent: 40 });
    expect((await api().get('/api/payouts/settings').set(b.headers)).body.defaultPercent).toBe(0);
  });

  it('registra a alteração na auditoria, só com os nomes dos campos', async () => {
    const c = await setup();
    await settings(c, { defaultPercent: 40 });
    const log = await db('audit_log').where({ entity: 'payout_settings' }).first();
    expect(log).toMatchObject({ action: 'update', changes: { fields: ['defaultPercent'] }, user_id: c.user.id });
  });

  it.each([
    ['corpo vazio', {}],
    ['momento de liberação inválido', { releaseOn: 'nunca' }],
    ['percentual acima de 100', { defaultPercent: 100.01 }],
    ['percentual negativo', { creditCardFeePercent: -1 }],
    ['mais de 2 casas decimais', { debitCardFeePercent: 1.234 }],
    ['percentual em texto', { defaultPercent: '30' }],
    ['flag que não é booleana', { deductCosts: 'sim' }],
  ])('recusa %s', async (_, body) => {
    const c = await setup();
    const res = await api().patch('/api/payouts/settings').set(c.headers).send(body);
    expect(res.status).toBe(400);
    expect(await db('payout_settings')).toHaveLength(0);
  });
});

describe('regras por exceção', () => {
  it('cria regra em percentual para um procedimento (todos os dentistas)', async () => {
    const c = await setup();
    const created = await rule(c, { procedureId: c.filling.id, type: 'percent', percent: 45.5 });
    expect(created).toMatchObject({ procedure: { id: c.filling.id, name: 'Restauração' }, dentist: null, type: 'percent', percent: 45.5, fixedCents: null });
  });

  it('cria regra em valor fixo para um dentista específico', async () => {
    const c = await setup();
    const created = await rule(c, { procedureId: c.filling.id, dentistId: c.id, type: 'fixed', fixedCents: 3000 });
    expect(created).toMatchObject({ dentist: { id: c.id, name: 'Dr. Paulo' }, type: 'fixed', percent: null, fixedCents: 3000 });
  });

  it('aceita 0% e valor fixo zero (quem não recebe nada naquele procedimento)', async () => {
    const c = await setup();
    await rule(c, { procedureId: c.filling.id, type: 'percent', percent: 0 });
    await rule(c, { procedureId: c.cleaning.id, type: 'fixed', fixedCents: 0 });
  });

  it('não repete regra do mesmo procedimento (e dentista), mas aceita uma geral e uma por dentista', async () => {
    const c = await setup();
    await rule(c, { procedureId: c.filling.id, type: 'percent', percent: 40 });
    await rule(c, { procedureId: c.filling.id, dentistId: c.id, type: 'percent', percent: 50 });
    for (const extra of [{}, { dentistId: c.id }]) {
      const res = await api().post('/api/payouts/rules').set(c.headers).send({ procedureId: c.filling.id, type: 'percent', percent: 10, ...extra });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('RULE_EXISTS');
    }
    expect((await api().get('/api/payouts/rules').set(c.headers)).body).toHaveLength(2);
  });

  it.each([
    ['percentual sem o valor', { type: 'percent' }],
    ['percentual com valor fixo', { type: 'percent', percent: 10, fixedCents: 100 }],
    ['valor fixo sem o valor', { type: 'fixed' }],
    ['valor fixo com percentual', { type: 'fixed', fixedCents: 100, percent: 10 }],
    ['tipo desconhecido', { type: 'bonus', percent: 10 }],
    ['percentual acima de 100', { type: 'percent', percent: 101 }],
    ['valor fixo fracionado', { type: 'fixed', fixedCents: 10.5 }],
    ['valor fixo negativo', { type: 'fixed', fixedCents: -1 }],
  ])('recusa %s', async (_, body) => {
    const c = await setup();
    const res = await api().post('/api/payouts/rules').set(c.headers).send({ procedureId: c.filling.id, ...body });
    expect(res.status).toBe(400);
  });

  it('recusa procedimento ou dentista inexistente, e dentista de outra clínica', async () => {
    const c = await setup();
    const stranger = await setup();
    const noProcedure = await api().post('/api/payouts/rules').set(c.headers).send({ procedureId: stranger.filling.id, type: 'percent', percent: 10 });
    const noDentist = await api().post('/api/payouts/rules').set(c.headers).send({ procedureId: c.filling.id, dentistId: stranger.id, type: 'percent', percent: 10 });
    expect([noProcedure.status, noDentist.status]).toEqual([404, 404]);
    expect(noProcedure.body.error).toContain('Procedimento');
    expect(noDentist.body.error).toContain('Dentista');
  });

  it('lista com filtros por procedimento e por dentista, em ordem de procedimento', async () => {
    const c = await setup();
    await rule(c, { procedureId: c.filling.id, type: 'percent', percent: 40 });
    await rule(c, { procedureId: c.cleaning.id, dentistId: c.otherId, type: 'fixed', fixedCents: 1000 });
    const all = (await api().get('/api/payouts/rules').set(c.headers)).body;
    expect(all.map((r) => r.procedure.name)).toEqual(['Limpeza', 'Restauração']);
    const byProcedure = (await api().get(`/api/payouts/rules?procedureId=${c.filling.id}`).set(c.headers)).body;
    expect(byProcedure.map((r) => r.procedure.name)).toEqual(['Restauração']);
    const byDentist = (await api().get(`/api/payouts/rules?dentistId=${c.otherId}`).set(c.headers)).body;
    expect(byDentist.map((r) => r.dentist.name)).toEqual(['Dra. Bia']);
  });

  it('altera o valor e o tipo da regra, sem mudar procedimento nem dentista', async () => {
    const c = await setup();
    const created = await rule(c, { procedureId: c.filling.id, dentistId: c.id, type: 'percent', percent: 40 });
    const res = await api().patch(`/api/payouts/rules/${created.id}`).set(c.headers).send({ type: 'fixed', fixedCents: 2500 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.id, type: 'fixed', fixedCents: 2500, percent: null, dentist: { id: c.id } });
    const back = await api().patch(`/api/payouts/rules/${created.id}`).set(c.headers).send({ type: 'percent', percent: 12.25 });
    expect(back.body).toMatchObject({ type: 'percent', percent: 12.25, fixedCents: null });
  });

  it('alteração inválida ou de regra inexistente não funciona', async () => {
    const c = await setup();
    const created = await rule(c, { procedureId: c.filling.id, type: 'percent', percent: 40 });
    expect((await api().patch(`/api/payouts/rules/${created.id}`).set(c.headers).send({ type: 'fixed' })).status).toBe(400);
    expect((await api().patch(`/api/payouts/rules/${created.id}`).set(c.headers).send({})).status).toBe(400);
    expect((await api().patch('/api/payouts/rules/0b0d2f7e-8f7b-4d49-9d63-3c2f1f2a1b11').set(c.headers).send({ type: 'percent', percent: 1 })).status).toBe(404);
    expect((await db('payout_rules').first()).percent).toBe('40.00');
  });

  it('remove a regra (204) e responde 404 na segunda vez', async () => {
    const c = await setup();
    const created = await rule(c, { procedureId: c.filling.id, type: 'percent', percent: 40 });
    expect((await api().delete(`/api/payouts/rules/${created.id}`).set(c.headers)).status).toBe(204);
    expect((await api().delete(`/api/payouts/rules/${created.id}`).set(c.headers)).status).toBe(404);
    expect(await db('payout_rules')).toHaveLength(0);
    const actions = (await db('audit_log').where({ entity: 'payout_rule' }).orderBy('created_at')).map((l) => l.action);
    expect(actions).toEqual(['create', 'delete']);
  });

  it('o banco recusa regra incoerente mesmo se o código errar', async () => {
    const c = await setup();
    const base = { clinic_id: c.clinic.id, procedure_id: c.filling.id };
    await expect(db('payout_rules').insert({ ...base, type: 'percent', percent: 10, fixed_cents: 5 })).rejects.toThrow();
    await expect(db('payout_rules').insert({ ...base, type: 'fixed', fixed_cents: -1 })).rejects.toThrow();
    await expect(db('payout_rules').insert({ ...base, type: 'percent', percent: 101 })).rejects.toThrow();
  });
});

describe('qual regra vale (resolve)', () => {
  const resolve = (c, dentistId, procedureId) => api().get(`/api/payouts/rules/resolve?dentistId=${dentistId}&procedureId=${procedureId}`).set(c.headers);

  it('segue a ordem: dentista+procedimento, procedimento, percentual do dentista, padrão da clínica', async () => {
    const c = await setup();
    expect((await resolve(c, c.id, c.filling.id)).body).toMatchObject({ source: 'clinic_default', type: 'percent', percent: 0 });

    await settings(c, { defaultPercent: 10 });
    expect((await resolve(c, c.id, c.filling.id)).body).toMatchObject({ source: 'clinic_default', percent: 10 });

    await dentistPercent(c, c.dentist, 30);
    expect((await resolve(c, c.id, c.filling.id)).body).toMatchObject({ source: 'dentist', percent: 30 });
    expect((await resolve(c, c.otherId, c.filling.id)).body).toMatchObject({ source: 'clinic_default', percent: 10 });

    await rule(c, { procedureId: c.filling.id, type: 'fixed', fixedCents: 4000 });
    expect((await resolve(c, c.id, c.filling.id)).body).toMatchObject({ source: 'procedure', type: 'fixed', fixedCents: 4000, percent: null });
    expect((await resolve(c, c.id, c.cleaning.id)).body).toMatchObject({ source: 'dentist', percent: 30 });

    await rule(c, { procedureId: c.filling.id, dentistId: c.id, type: 'percent', percent: 60 });
    expect((await resolve(c, c.id, c.filling.id)).body).toMatchObject({ source: 'dentist_procedure', type: 'percent', percent: 60, dentist: { name: 'Dr. Paulo' }, procedure: { name: 'Restauração' } });
    expect((await resolve(c, c.otherId, c.filling.id)).body).toMatchObject({ source: 'procedure', fixedCents: 4000 });
  });

  it('dentista ou procedimento inexistente dá 404; sem os dois parâmetros dá 400', async () => {
    const c = await setup();
    const unknown = '0b0d2f7e-8f7b-4d49-9d63-3c2f1f2a1b11';
    expect((await resolve(c, unknown, c.filling.id)).status).toBe(404);
    expect((await resolve(c, c.id, unknown)).status).toBe(404);
    expect((await api().get(`/api/payouts/rules/resolve?dentistId=${c.id}`).set(c.headers)).status).toBe(400);
  });
});
