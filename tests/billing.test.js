import { afterEach, describe, expect, it, vi } from 'vitest';
import db from '../src/db/knex.js';
import { sendOwnerNotice } from '../src/services/mailer.js';
import { addDays, businessDate } from '../src/utils/dates.js';
import { parsePixPayload } from '../src/utils/pix.js';
import { api, createClinic, createDentist, createUser, platformSession, setupUser } from './helpers/factories.js';

afterEach(() => vi.unstubAllEnvs());

const today = () => businessDate();
const setSub = (clinicId, changes) => db('subscriptions').where({ clinic_id: clinicId }).update(changes);
const getSub = (clinicId) => db('subscriptions').where({ clinic_id: clinicId }).first();
const planBy = (code) => db('plans').where({ code }).first();
const status = (s) => api().get('/api/billing/status').set(s.headers);
const billing = (s) => api().get('/api/billing').set(s.headers);
const choose = async (s, code = 'clinica') => api().post('/api/billing/plan').set(s.headers).send({ planId: (await planBy(code)).id });
const withPix = () => vi.stubEnv('BILLING_PIX_KEY', '11144477735');

describe('situação da assinatura', () => {
  it('clínica nova começa em teste grátis de 14 dias, sem plano', async () => {
    const s = await setupUser();
    const res = await status(s);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      state: 'trial', blocked: false, endsOn: addDays(today(), 14), daysLeft: 14, graceEndsOn: addDays(today(), 21), planName: null,
    });
  });

  it('a duração do teste vem de TRIAL_DAYS no cadastro de clínicas', async () => {
    vi.stubEnv('TRIAL_DAYS', '30');
    const platform = await platformSession();
    const res = await api().post('/api/platform/clinics').set(platform.headers).send({
      name: 'Clínica Longa', admin: { name: 'Ana', email: 'ana@longa.test', password: 'senha-da-ana-123' },
    });
    expect(res.status).toBe(201);
    const clinic = await db('clinics').where({ id: res.body.clinic.id }).first();
    expect((await getSub(clinic.id)).trial_ends_on).toBe(addDays(today(), 30));
  });

  it('qualquer perfil vê a situação, mas só o administrador vê a assinatura completa', async () => {
    const admin = await setupUser();
    for (const role of ['secretary', 'dentist']) {
      const s = await setupUser({ role, clinic: admin.clinic });
      expect((await status(s)).status).toBe(200);
      expect((await billing(s)).status).toBe(403);
    }
    expect((await billing(admin)).status).toBe(200);
  });

  it('a assinatura mostra os planos à venda, sem fatura nem plano escolhido durante o teste', async () => {
    const s = await setupUser();
    const { body } = await billing(s);
    expect(body).toMatchObject({
      state: 'trial', plan: null, invoice: null, invoices: [], pixConfigured: false, courtesyIndefinite: false, paidUntil: null, deletionRequestedAt: null,
    });
    expect(body.plans.map((p) => [p.code, p.priceCents, p.maxDentists])).toEqual([['essencial', 7900, 1], ['clinica', 14900, 4], ['premium', 24900, null]]);
  });

  it('planos desativados não aparecem para escolha', async () => {
    await db('plans').where({ code: 'premium' }).update({ active: false });
    const s = await setupUser();
    expect((await billing(s)).body.plans.map((p) => p.code)).toEqual(['essencial', 'clinica']);
  });
});

describe('escolher o plano', () => {
  it('gera a fatura do primeiro período, que começa depois do teste, com o Pix pronto', async () => {
    withPix();
    const s = await setupUser();
    const res = await choose(s);
    expect(res.status).toBe(200);
    const trialEnd = addDays(today(), 14);
    expect(res.body.plan).toMatchObject({ code: 'clinica', priceCents: 14900 });
    expect(res.body.invoice).toMatchObject({
      status: 'OPEN', amountCents: 14900, periodStart: addDays(trialEnd, 1), dueOn: addDays(trialEnd, 1), reportedPaidAt: null, paidAt: null,
    });
    expect(res.body.invoice.periodEnd > res.body.invoice.periodStart).toBe(true);

    const { pix } = res.body.invoice;
    expect(pix).toMatchObject({ key: '11144477735', beneficiary: 'OdontoApp', instructions: null, reason: null });
    const fields = parsePixPayload(pix.payload);
    expect(fields['54']).toBe('149.00');
    expect(fields['59']).toBe('ODONTOAPP');
    expect(fields['60']).toBe('BRAZOPOLIS');
    expect(fields['62']).toContain(`ODT${res.body.invoice.id.replaceAll('-', '')}`.slice(0, 20));
    expect(res.body.pixConfigured).toBe(true);
    expect((await db('clinics').where({ id: s.clinic.id }).first()).plan).toBe('basic'); // só muda quando o pagamento é confirmado
    expect(await db('billing_events').where({ clinic_id: s.clinic.id, type: 'plan_chosen' })).toHaveLength(1);
  });

  it('sem chave Pix configurada a fatura nasce sem os dados de pagamento', async () => {
    const s = await setupUser();
    const { body } = await choose(s);
    expect(body.invoice.pix).toBeNull();
    expect(body.pixConfigured).toBe(false);
  });

  it('plano inexistente ou desativado: 404; corpo inválido: 400', async () => {
    const s = await setupUser();
    await db('plans').where({ code: 'essencial' }).update({ active: false });
    const off = await planBy('essencial');
    expect((await api().post('/api/billing/plan').set(s.headers).send({ planId: off.id })).status).toBe(404);
    expect((await api().post('/api/billing/plan').set(s.headers).send({ planId: '4b1a8b9c-2f3d-4e5a-8c7b-1d2e3f4a5b6c' })).status).toBe(404);
    expect((await api().post('/api/billing/plan').set(s.headers).send({ planId: 'x' })).status).toBe(400);
  });

  it('trocar de plano substitui a fatura em aberto pela do novo preço', async () => {
    const s = await setupUser();
    const first = (await choose(s, 'clinica')).body.invoice;
    const second = (await choose(s, 'premium')).body.invoice;
    expect(second.id).not.toBe(first.id);
    expect(second.amountCents).toBe(24900);
    const rows = await db('invoices').where({ clinic_id: s.clinic.id }).orderBy('created_at');
    expect(rows.map((i) => i.status).sort()).toEqual(['OPEN', 'VOID']);
  });

  it('não deixa escolher plano com menos vagas do que dentistas ativos (PLAN_LIMIT)', async () => {
    const s = await setupUser();
    await createDentist(s.clinic);
    await createDentist(s.clinic);
    const res = await choose(s, 'essencial');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PLAN_LIMIT');
    expect((await choose(s, 'clinica')).status).toBe(200);
  });

  it('com pagamento avisado e ainda não confirmado, não troca de plano (PAYMENT_PENDING)', async () => {
    const s = await setupUser();
    const { invoice } = (await choose(s)).body;
    await api().post(`/api/billing/invoices/${invoice.id}/reported`).set(s.headers).send({});
    const res = await choose(s, 'premium');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYMENT_PENDING');
  });
});

describe('"Já paguei"', () => {
  it('marca a fatura como avisada e avisa o dono da plataforma', async () => {
    const s = await setupUser();
    const { invoice } = (await choose(s)).body;
    const res = await api().post(`/api/billing/invoices/${invoice.id}/reported`).set(s.headers).send({ note: 'Pix das 10h' });
    expect(res.status).toBe(200);
    expect(res.body.invoice).toMatchObject({ id: invoice.id, status: 'OPEN', reportedNote: 'Pix das 10h' });
    expect(res.body.invoice.reportedPaidAt).toBeTruthy();
    expect(sendOwnerNotice).toHaveBeenCalledTimes(1);
    const { subject, text } = sendOwnerNotice.mock.calls[0][0];
    expect(subject).toBe('Pagamento informado');
    expect(text).toContain('R$ 149,00');
    expect(text).toContain('Pix das 10h');
  });

  it('funciona sem observação e mesmo se o aviso ao dono falhar', async () => {
    sendOwnerNotice.mockRejectedValue(new Error('smtp fora do ar'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = await setupUser();
    const { invoice } = (await choose(s)).body;
    const res = await api().post(`/api/billing/invoices/${invoice.id}/reported`).set(s.headers).send({});
    expect(res.status).toBe(200);
    expect(res.body.invoice.reportedNote).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('avisar duas vezes: 409; fatura inexistente: 404; fatura já paga: 409', async () => {
    const s = await setupUser();
    const { invoice } = (await choose(s)).body;
    const path = (id) => `/api/billing/invoices/${id}/reported`;
    expect((await api().post(path(invoice.id)).set(s.headers).send({})).status).toBe(200);
    const again = await api().post(path(invoice.id)).set(s.headers).send({});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_REPORTED');
    expect(sendOwnerNotice).toHaveBeenCalledTimes(1);

    expect((await api().post(path('4b1a8b9c-2f3d-4e5a-8c7b-1d2e3f4a5b6c')).set(s.headers).send({})).status).toBe(404);
    await db('invoices').where({ id: invoice.id }).update({ status: 'PAID' });
    const paid = await api().post(path(invoice.id)).set(s.headers).send({});
    expect(paid.status).toBe(409);
    expect(paid.body.code).toBe('INVOICE_NOT_OPEN');
    expect((await api().post(path('x')).set(s.headers).send({})).status).toBe(400);
  });

  it('uma clínica não avisa pagamento de fatura de outra', async () => {
    const a = await setupUser();
    const b = await setupUser();
    const { invoice } = (await choose(b)).body;
    expect((await api().post(`/api/billing/invoices/${invoice.id}/reported`).set(a.headers).send({})).status).toBe(404);
    expect((await db('invoices').where({ id: invoice.id }).first()).reported_paid_at).toBeNull();
  });
});

describe('fatura do próximo período', () => {
  const chosen = async (changes) => {
    const s = await setupUser();
    await setSub(s.clinic.id, { plan_id: (await planBy('clinica')).id, trial_ends_on: addDays(today(), -60), ...changes });
    return s;
  };

  it('não nasce enquanto falta muito para o fim do período pago', async () => {
    const s = await chosen({ paid_until: addDays(today(), 30) });
    expect((await billing(s)).body.invoice).toBeNull();
  });

  it('nasce quando faltam 7 dias ou menos, começa no dia seguinte ao fim e não se repete', async () => {
    const s = await chosen({ paid_until: addDays(today(), 5) });
    const [one, two] = await Promise.all([billing(s), billing(s)]); // duas telas abertas ao mesmo tempo
    expect(one.body.invoice.periodStart).toBe(addDays(today(), 6));
    expect(two.body.invoice.id).toBe(one.body.invoice.id);
    expect(await db('invoices').where({ clinic_id: s.clinic.id })).toHaveLength(1);
    expect((await billing(s)).body.invoice.id).toBe(one.body.invoice.id);
  });

  it('com o período vencido, a fatura vale a partir de hoje e vence hoje', async () => {
    const s = await chosen({ paid_until: addDays(today(), -3), trial_ends_on: addDays(today(), -20) });
    const { invoice } = (await billing(s)).body;
    expect(invoice).toMatchObject({ periodStart: today(), dueOn: today() });
  });

  it('cortesia sem fim e clínica sem plano escolhido não recebem fatura', async () => {
    const free = await chosen({ courtesy_indefinite: true, trial_ends_on: addDays(today(), -20) });
    expect((await billing(free)).body.invoice).toBeNull();
    const none = await setupUser();
    await setSub(none.clinic.id, { trial_ends_on: addDays(today(), -20) });
    expect((await billing(none)).body.invoice).toBeNull();
  });
});

describe('Pix da fatura', () => {
  it('mostra instruções e usa o tipo informado em BILLING_PIX_KEY_TYPE', async () => {
    vi.stubEnv('BILLING_PIX_KEY', 'pix@odontoapp.com.br');
    vi.stubEnv('BILLING_PIX_KEY_TYPE', 'EMAIL');
    vi.stubEnv('BILLING_PIX_INSTRUCTIONS', 'Envie o comprovante pelo WhatsApp.');
    vi.stubEnv('BILLING_PIX_BENEFICIARY', 'Júlio Silva');
    const s = await setupUser();
    const { pix } = (await choose(s)).body.invoice;
    expect(pix).toMatchObject({ key: 'pix@odontoapp.com.br', beneficiary: 'Júlio Silva', instructions: 'Envie o comprovante pelo WhatsApp.', reason: null });
    expect(parsePixPayload(pix.payload)['59']).toBe('JULIO SILVA');
  });

  it('chave inválida não gera o QR, mas a clínica ainda vê a chave', async () => {
    vi.stubEnv('BILLING_PIX_KEY', 'chave-invalida');
    const s = await setupUser();
    const { pix } = (await choose(s)).body.invoice;
    expect(pix).toMatchObject({ key: 'chave-invalida', payload: null, reason: 'PIX_KEY_INVALID' });
  });

  it('chave que é CPF e telefone ao mesmo tempo precisa do tipo; com BILLING_PIX_KEY_TYPE funciona', async () => {
    vi.stubEnv('BILLING_PIX_KEY', '52998224725');
    const s = await setupUser();
    const ambiguous = (await choose(s)).body.invoice.pix;
    expect(ambiguous).toMatchObject({ key: '52998224725', payload: null, reason: 'PIX_KEY_AMBIGUOUS' });

    vi.stubEnv('BILLING_PIX_KEY_TYPE', 'CPF');
    const fixed = (await billing(s)).body.invoice.pix;
    expect(fixed).toMatchObject({ key: '52998224725', reason: null });
    expect(parsePixPayload(fixed.payload)['01']).toBe('11');
  });
});

describe('confirmação do pagamento pelo dono da plataforma', () => {
  const pay = (platform, clinicId, invoiceId, body = {}) =>
    api().post(`/api/platform/clinics/${clinicId}/invoices/${invoiceId}/pay`).set(platform.headers).send(body);

  it('estende o acesso por 1 mês a partir do fim do teste e troca o plano da clínica', async () => {
    const platform = await platformSession();
    const s = await setupUser();
    const { invoice } = (await choose(s, 'premium')).body;
    const res = await pay(platform, s.clinic.id, invoice.id, { note: 'Pix conferido' });
    expect(res.status).toBe(200);
    const start = addDays(addDays(today(), 14), 1);
    expect(res.body.state).toBe('active'); // pago até o fim do mês que começa depois do teste
    expect(res.body.paidUntil).toBe(res.body.invoices[0].periodEnd);
    expect(res.body.invoices[0]).toMatchObject({ status: 'PAID', periodStart: start, paymentNote: 'Pix conferido' });
    expect(res.body.invoice).toBeNull();
    expect((await db('clinics').where({ id: s.clinic.id }).first()).plan).toBe('premium');
    expect((await db('invoices').where({ id: invoice.id }).first()).paid_by_admin_id).toBe(platform.admin.id);
    expect(res.body.events.map((e) => e.type)).toEqual(expect.arrayContaining(['invoice_paid', 'plan_chosen']));
    expect((await status(s)).body.state).toBe('active');
  });

  it('pagando depois de vencido, o mês começa hoje e o acesso volta', async () => {
    const platform = await platformSession();
    const s = await setupUser();
    await setSub(s.clinic.id, { trial_ends_on: addDays(today(), -20) });
    const { invoice } = (await choose(s)).body;
    expect((await status(s)).body.state).toBe('suspended');
    const res = await pay(platform, s.clinic.id, invoice.id);
    expect(res.body.state).toBe('active');
    expect(res.body.invoices[0].periodStart).toBe(today());
    expect((await api().get('/api/patients').set(s.headers)).status).toBe(200);
  });

  it('renovando antes do fim, o novo mês emenda no período pago', async () => {
    const platform = await platformSession();
    const s = await setupUser();
    const planId = (await planBy('clinica')).id;
    await setSub(s.clinic.id, { plan_id: planId, paid_until: addDays(today(), 3), trial_ends_on: addDays(today(), -30) });
    const { invoice } = (await billing(s)).body;
    const res = await pay(platform, s.clinic.id, invoice.id);
    expect(res.body.invoices[0].periodStart).toBe(addDays(today(), 4));
    expect(res.body.state).toBe('active');
  });

  it('fatura já paga: 409; fatura de outra clínica ou inexistente: 404; clínica inexistente: 404', async () => {
    const platform = await platformSession();
    const a = await setupUser();
    const b = await setupUser();
    const { invoice } = (await choose(a)).body;
    expect((await pay(platform, a.clinic.id, invoice.id)).status).toBe(200);
    const again = await pay(platform, a.clinic.id, invoice.id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVOICE_NOT_OPEN');

    const other = (await choose(b)).body.invoice;
    expect((await pay(platform, a.clinic.id, other.id)).status).toBe(404);
    expect((await pay(platform, a.clinic.id, '4b1a8b9c-2f3d-4e5a-8c7b-1d2e3f4a5b6c')).status).toBe(404);
    expect((await pay(platform, '4b1a8b9c-2f3d-4e5a-8c7b-1d2e3f4a5b6c', other.id)).status).toBe(404);
    expect((await db('invoices').where({ id: other.id }).first()).status).toBe('OPEN');
  });
});

describe('teste e cortesia (plataforma)', () => {
  const extend = (platform, clinicId, days) => api().post(`/api/platform/clinics/${clinicId}/trial/extend`).set(platform.headers).send({ days });
  const courtesy = (platform, clinicId, body) => api().put(`/api/platform/clinics/${clinicId}/courtesy`).set(platform.headers).send(body);

  it('estender soma dias ao fim do teste; se o teste já acabou, soma a partir de hoje', async () => {
    const platform = await platformSession();
    const s = await setupUser();
    expect((await extend(platform, s.clinic.id, 10)).body.trialEndsOn).toBe(addDays(today(), 24));
    await setSub(s.clinic.id, { trial_ends_on: addDays(today(), -50) });
    const res = await extend(platform, s.clinic.id, 5);
    expect(res.body.trialEndsOn).toBe(addDays(today(), 5));
    expect(res.body.state).toBe('trial');
  });

  it('valida os dias e a clínica', async () => {
    const platform = await platformSession();
    const s = await setupUser();
    for (const days of [0, -1, 1.5, 366, 'x']) expect((await extend(platform, s.clinic.id, days)).status, String(days)).toBe(400);
    expect((await extend(platform, '4b1a8b9c-2f3d-4e5a-8c7b-1d2e3f4a5b6c', 3)).status).toBe(404);
  });

  it('cortesia sem fim, até uma data e removida', async () => {
    const platform = await platformSession();
    const s = await setupUser();
    await setSub(s.clinic.id, { trial_ends_on: addDays(today(), -10) });
    const forever = await courtesy(platform, s.clinic.id, { indefinite: true, until: '2030-01-01' });
    expect(forever.body).toMatchObject({ state: 'courtesy', blocked: false, endsOn: null, daysLeft: null, courtesyIndefinite: true, courtesyUntil: null });

    const until = await courtesy(platform, s.clinic.id, { until: addDays(today(), 10) });
    expect(until.body).toMatchObject({ state: 'courtesy', courtesyIndefinite: false, courtesyUntil: addDays(today(), 10), daysLeft: 10 });

    const none = await courtesy(platform, s.clinic.id, {});
    expect(none.body).toMatchObject({ state: 'suspended', courtesyUntil: null });
  });

  it('valida a data e a clínica da cortesia', async () => {
    const platform = await platformSession();
    const s = await setupUser();
    expect((await courtesy(platform, s.clinic.id, { until: '2026-02-31' })).status).toBe(400);
    expect((await courtesy(platform, s.clinic.id, { until: 'amanhã' })).status).toBe(400);
    expect((await courtesy(platform, '4b1a8b9c-2f3d-4e5a-8c7b-1d2e3f4a5b6c', { indefinite: true })).status).toBe(404);
  });

  it('a assinatura vista pela plataforma traz o histórico de eventos; clínica inexistente: 404', async () => {
    const platform = await platformSession();
    const s = await setupUser();
    await extend(platform, s.clinic.id, 3);
    const res = await api().get(`/api/platform/clinics/${s.clinic.id}/billing`).set(platform.headers);
    expect(res.status).toBe(200);
    expect(res.body.events[0]).toMatchObject({ type: 'trial_extended', actor: `platform:${platform.admin.id}`, data: { days: 3 } });
    expect((await api().get('/api/platform/clinics/4b1a8b9c-2f3d-4e5a-8c7b-1d2e3f4a5b6c/billing').set(platform.headers)).status).toBe(404);
  });
});

describe('fila de faturas e planos (plataforma)', () => {
  it('lista as faturas em aberto; reported=true mostra só as que a clínica disse ter pago', async () => {
    withPix();
    const platform = await platformSession();
    const a = await setupUser();
    const b = await setupUser();
    await db('clinics').where({ id: a.clinic.id }).update({ name: 'Clínica Alfa' });
    const ia = (await choose(a)).body.invoice;
    await choose(b);
    await api().post(`/api/billing/invoices/${ia.id}/reported`).set(a.headers).send({});

    const all = await api().get('/api/platform/invoices').set(platform.headers);
    expect(all.body.total).toBe(2);
    expect(all.body.data[0]).toMatchObject({ id: ia.id, clinicName: 'Clínica Alfa' }); // as avisadas vêm primeiro
    expect(all.body.data[0].pix.payload).toBeTruthy();

    const reported = await api().get('/api/platform/invoices?reported=true').set(platform.headers);
    expect(reported.body.data.map((i) => i.id)).toEqual([ia.id]);
    const byName = await api().get('/api/platform/invoices?q=alfa').set(platform.headers);
    expect(byName.body.data.map((i) => i.id)).toEqual([ia.id]);

    await db('invoices').where({ id: ia.id }).update({ status: 'PAID' });
    const paid = await api().get('/api/platform/invoices?status=PAID').set(platform.headers);
    expect(paid.body.data).toHaveLength(1);
    expect(paid.body.data[0].pix).toBeNull();
    expect((await api().get('/api/platform/invoices?status=xx').set(platform.headers)).status).toBe(400);
  });

  it('lista e altera planos; o novo preço vale só nas próximas faturas', async () => {
    const platform = await platformSession();
    const s = await setupUser();
    const first = (await choose(s, 'essencial')).body.invoice;

    const plans = await api().get('/api/platform/plans').set(platform.headers);
    expect(plans.body.map((p) => p.code)).toEqual(['essencial', 'clinica', 'premium']);
    const essencial = plans.body[0];

    const res = await api().patch(`/api/platform/plans/${essencial.id}`).set(platform.headers)
      .send({ name: 'Essencial+', description: null, priceCents: 9900, maxDentists: 2, active: true, position: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Essencial+', description: null, priceCents: 9900, maxDentists: 2, active: true });
    expect((await db('invoices').where({ id: first.id }).first()).amount_cents).toBe(7900);
    expect((await choose(s, 'essencial')).body.invoice.amountCents).toBe(9900);

    const unlimited = await api().patch(`/api/platform/plans/${essencial.id}`).set(platform.headers).send({ maxDentists: null });
    expect(unlimited.body.maxDentists).toBeNull();
  });

  it('valida a alteração do plano', async () => {
    const platform = await platformSession();
    const plan = await planBy('clinica');
    const patch = (body, id = plan.id) => api().patch(`/api/platform/plans/${id}`).set(platform.headers).send(body);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ priceCents: 50 })).status).toBe(400);
    expect((await patch({ maxDentists: 0 })).status).toBe(400);
    expect((await patch({ name: 'X' })).status).toBe(400);
    expect((await patch({ name: 'Nome válido' }, '4b1a8b9c-2f3d-4e5a-8c7b-1d2e3f4a5b6c')).status).toBe(404);
  });
});

describe('suspensão por falta de pagamento', () => {
  const at = async (daysAfterTrial) => {
    const s = await setupUser();
    await setSub(s.clinic.id, { trial_ends_on: addDays(today(), -daysAfterTrial) });
    return s;
  };

  it.each([
    [0, 'trial', false], [1, 'past_due', false], [7, 'past_due', false], [8, 'suspended', true], [37, 'suspended', true], [38, 'canceled', true],
  ])('%i dia(s) depois do fim do teste: %s (bloqueada: %s)', async (days, state, blocked) => {
    const s = await at(days);
    const res = await status(s);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state, blocked, daysLeft: 0 - days });
    expect((await api().get('/api/patients').set(s.headers)).status).toBe(blocked ? 402 : 200);
  });

  it('suspensa: o painel responde 402, mas assinatura, exportação, login e leitura da clínica continuam', async () => {
    const s = await at(10);
    const blocked = await api().get('/api/patients').set(s.headers);
    expect(blocked.status).toBe(402);
    expect(blocked.body.code).toBe('SUBSCRIPTION_SUSPENDED');
    expect((await api().post('/api/patients').set(s.headers).send({ name: 'Fulano' })).status).toBe(402);
    expect((await api().patch('/api/clinic').set(s.headers).send({ name: 'Novo nome' })).status).toBe(402);
    expect((await api().get('/api/clinic/onboarding').set(s.headers)).status).toBe(402);

    for (const path of ['/api/auth/me', '/api/clinic', '/api/clinic?x=1', '/api/billing', '/api/billing/status', '/api/account/export']) {
      expect((await api().get(path).set(s.headers)).status, path).toBe(200);
    }
    const login = await api().post('/api/auth/login').send({ email: s.user.email, password: 'senha-segura-123' });
    expect(login.status).toBe(200);
  });

  it('quem não é administrador também vê o bloqueio, mas consegue ler a situação', async () => {
    const admin = await at(10);
    const secretary = await setupUser({ role: 'secretary', clinic: admin.clinic });
    expect((await api().get('/api/patients').set(secretary.headers)).status).toBe(402);
    expect((await status(secretary)).body.state).toBe('suspended');
  });

  it('a plataforma estende o teste e o acesso volta na hora', async () => {
    const platform = await platformSession();
    const s = await at(40);
    expect((await api().get('/api/patients').set(s.headers)).status).toBe(402);
    await api().post(`/api/platform/clinics/${s.clinic.id}/trial/extend`).set(platform.headers).send({ days: 5 });
    expect((await api().get('/api/patients').set(s.headers)).status).toBe(200);
  });

  it('a suspensão manual da plataforma continua valendo (403) e vence a do pagamento', async () => {
    const s = await at(10);
    await db('clinics').where({ id: s.clinic.id }).update({ status: 'suspended' });
    const res = await api().get('/api/patients').set(s.headers);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CLINIC_SUSPENDED');
  });

  it('o isolamento continua: outra clínica em dia não é afetada', async () => {
    const late = await at(10);
    const fine = await setupUser();
    await createUser(late.clinic);
    expect((await api().get('/api/patients').set(fine.headers)).status).toBe(200);
    expect((await createClinic()).id).toBeTruthy();
  });
});
