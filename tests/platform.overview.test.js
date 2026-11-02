import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { addDays, businessDate } from '../src/utils/dates.js';
import { api, createClinic, platformSession } from './helpers/factories.js';

const today = () => businessDate();
const setSub = (clinicId, changes) => db('subscriptions').where({ clinic_id: clinicId }).update(changes);
const planId = async (code) => (await db('plans').where({ code }).first()).id;

describe('clínicas com a situação da assinatura', () => {
  it('lista e consulta trazem o resumo da assinatura, o plano e o modelo escolhido', async () => {
    const platform = await platformSession();
    const trial = await createClinic({ name: 'Alfa', template_code: 'general' });
    const paying = await createClinic({ name: 'Beta' });
    await setSub(paying.id, { plan_id: await planId('clinica'), paid_until: addDays(today(), 20), deletion_requested_at: new Date() });

    const list = await api().get('/api/platform/clinics').set(platform.headers);
    expect(list.status).toBe(200);
    const [alfa, beta] = list.body.data;
    expect(alfa).toMatchObject({ name: 'Alfa', subscription: { state: 'trial', blocked: false, daysLeft: 14, planName: null, deletionRequestedAt: null, templateCode: 'general' } });
    expect(beta.subscription).toMatchObject({ state: 'active', planName: 'Clínica', templateCode: null });
    expect(beta.subscription.deletionRequestedAt).toBeTruthy();

    const one = await api().get(`/api/platform/clinics/${trial.id}`).set(platform.headers);
    expect(one.body.subscription.state).toBe('trial');
    expect((await api().get('/api/platform/clinics/4b1a8b9c-2f3d-4e5a-8c7b-1d2e3f4a5b6c').set(platform.headers)).status).toBe(404);
  });

  it('filtra por situação da assinatura e pagina o resultado', async () => {
    const platform = await platformSession();
    const late = [await createClinic({ name: 'C1' }), await createClinic({ name: 'C2' }), await createClinic({ name: 'C3' })];
    for (const c of late) await setSub(c.id, { trial_ends_on: addDays(today(), -20) });
    await createClinic({ name: 'Em teste' });

    const all = await api().get('/api/platform/clinics?billing=suspended').set(platform.headers);
    expect(all.body.total).toBe(3);
    expect(all.body.data.map((c) => c.name)).toEqual(['C1', 'C2', 'C3']);
    const second = await api().get('/api/platform/clinics?billing=suspended&perPage=2&page=2').set(platform.headers);
    expect(second.body.data.map((c) => c.name)).toEqual(['C3']);
    expect(second.body).toMatchObject({ total: 3, totalPages: 2 });
    expect((await api().get('/api/platform/clinics?billing=trial').set(platform.headers)).body.data.map((c) => c.name)).toEqual(['Em teste']);
    expect((await api().get('/api/platform/clinics?billing=nada').set(platform.headers)).status).toBe(400);
  });

  it('continua filtrando por busca e situação manual', async () => {
    const platform = await platformSession();
    await createClinic({ name: 'Sorriso Feliz' });
    await createClinic({ name: 'Outra', status: 'suspended' });
    expect((await api().get('/api/platform/clinics?q=sorriso').set(platform.headers)).body.total).toBe(1);
    expect((await api().get('/api/platform/clinics?status=suspended&billing=trial').set(platform.headers)).body.data.map((c) => c.name)).toEqual(['Outra']);
  });
});

describe('GET /api/platform/overview', () => {
  it('sem clínicas, tudo zerado', async () => {
    const platform = await platformSession();
    const res = await api().get('/api/platform/overview').set(platform.headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      clinics: { total: 0, suspendedManually: 0, byState: { trial: 0, active: 0, courtesy: 0, past_due: 0, suspended: 0, canceled: 0 } },
      mrrCents: 0, awaitingConfirmation: { count: 0, amountCents: 0 }, openInvoices: 0, deletionRequests: 0, newLast7Days: 0, newLast30Days: 0,
    });
  });

  it('conta as clínicas por situação, a receita recorrente, as faturas e os cadastros recentes', async () => {
    const platform = await platformSession();
    const clinica = await planId('clinica');
    const premium = await planId('premium');
    const trial = await createClinic({ name: 'T' });
    const active = await createClinic({ name: 'A' });
    const grace = await createClinic({ name: 'G', status: 'suspended' });
    const out = await createClinic({ name: 'S' });
    const free = await createClinic({ name: 'F' });
    await setSub(active.id, { plan_id: clinica, paid_until: addDays(today(), 10), deletion_requested_at: new Date() });
    await setSub(grace.id, { plan_id: premium, trial_ends_on: addDays(today(), -3) });
    await setSub(out.id, { plan_id: clinica, trial_ends_on: addDays(today(), -30) }); // suspensa não entra na receita
    await setSub(free.id, { courtesy_indefinite: true, plan_id: premium }); // cortesia não entra na receita
    await db('clinics').where({ id: trial.id }).update({ created_at: new Date(Date.now() - 20 * 86_400_000) });
    await db('clinics').where({ id: out.id }).update({ created_at: new Date(Date.now() - 60 * 86_400_000) });

    const subs = await db('subscriptions');
    const sub = (id) => subs.find((x) => x.clinic_id === id);
    await db('invoices').insert([
      { clinic_id: active.id, subscription_id: sub(active.id).id, plan_id: clinica, amount_cents: 14900, period_start: '2099-01-01', period_end: '2099-01-31', due_on: '2099-01-01', reported_paid_at: new Date() },
      { clinic_id: grace.id, subscription_id: sub(grace.id).id, plan_id: premium, amount_cents: 24900, period_start: '2099-01-01', period_end: '2099-01-31', due_on: '2099-01-01' },
      { clinic_id: out.id, subscription_id: sub(out.id).id, plan_id: clinica, amount_cents: 14900, period_start: '2099-01-01', period_end: '2099-01-31', due_on: '2099-01-01', status: 'PAID' },
    ]);

    const { body } = await api().get('/api/platform/overview').set(platform.headers);
    expect(body.clinics).toEqual({
      total: 5, suspendedManually: 1, byState: { trial: 1, active: 1, courtesy: 1, past_due: 1, suspended: 1, canceled: 0 },
    });
    expect(body.mrrCents).toBe(14900 + 24900);
    expect(body.awaitingConfirmation).toEqual({ count: 1, amountCents: 14900 });
    expect(body.openInvoices).toBe(2);
    expect(body.deletionRequests).toBe(1);
    expect(body.newLast7Days).toBe(3);
    expect(body.newLast30Days).toBe(4);
  });
});
