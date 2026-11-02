// Regras que cruzam a assinatura com o resto do sistema: situação calculada, rotas liberadas, limite de dentistas e lembretes.
import { describe, expect, it, vi } from 'vitest';
import db from '../src/db/knex.js';
import { computeAccess, coveredUntil, isOpenWhenSuspended, nextPeriodStart } from '../src/modules/billing/access.js';
import { runReminders } from '../src/modules/notifications/notifications.reminders.js';
import { sendAppointmentReminderEmail } from '../src/services/mailer.js';
import { addDays, businessDate } from '../src/utils/dates.js';
import { api, bearer, createDentist, createUser, setupUser } from './helpers/factories.js';
import { buildClinic } from './helpers/fixtures.js';
import { appointmentIn, setup } from './helpers/notices.js';

const today = '2026-11-10';
const sub = (o = {}) => ({ trial_ends_on: '2026-10-01', paid_until: null, courtesy_until: null, courtesy_indefinite: false, ...o });

describe('computeAccess', () => {
  it('teste em andamento', () => {
    expect(computeAccess(sub({ trial_ends_on: '2026-11-15' }), today)).toEqual({
      state: 'trial', blocked: false, endsOn: '2026-11-15', daysLeft: 5, graceEndsOn: '2026-11-22',
    });
    expect(computeAccess(sub({ trial_ends_on: today }), today)).toMatchObject({ state: 'trial', daysLeft: 0 });
  });

  it('pago em dia vale mais que o teste vencido; cortesia com data vale quando não há pagamento', () => {
    expect(computeAccess(sub({ paid_until: '2026-12-01' }), today)).toMatchObject({ state: 'active', endsOn: '2026-12-01', daysLeft: 21 });
    expect(computeAccess(sub({ courtesy_until: '2026-11-20' }), today)).toMatchObject({ state: 'courtesy', endsOn: '2026-11-20', daysLeft: 10 });
    expect(computeAccess(sub({ paid_until: '2026-12-01', courtesy_until: '2027-01-01' }), today).state).toBe('active');
  });

  it('cortesia sem fim nunca vence', () => {
    expect(computeAccess(sub({ courtesy_indefinite: true }), '2099-01-01')).toEqual({
      state: 'courtesy', blocked: false, endsOn: null, daysLeft: null, graceEndsOn: null,
    });
  });

  it('depois do fim: carência, suspensa e cancelada, contando do último dia coberto', () => {
    const late = (days) => computeAccess(sub({ trial_ends_on: addDays(today, -days) }), today);
    expect(late(1)).toMatchObject({ state: 'past_due', blocked: false, daysLeft: -1 });
    expect(late(7)).toMatchObject({ state: 'past_due', blocked: false });
    expect(late(8)).toMatchObject({ state: 'suspended', blocked: true, daysLeft: -8 });
    expect(late(37).state).toBe('suspended');
    expect(late(38)).toMatchObject({ state: 'canceled', blocked: true });
    // o último dia coberto é o maior entre teste, pagamento e cortesia
    expect(computeAccess(sub({ paid_until: addDays(today, -3) }), today)).toMatchObject({ state: 'past_due', endsOn: addDays(today, -3), daysLeft: -3 });
  });

  it('os prazos vêm da configuração', () => {
    vi.stubEnv('BILLING_GRACE_DAYS', '2');
    vi.stubEnv('BILLING_CANCEL_AFTER_DAYS', '3');
    const late = (days) => computeAccess(sub({ trial_ends_on: addDays(today, -days) }), today).state;
    expect([late(2), late(3), late(5), late(6)]).toEqual(['past_due', 'suspended', 'suspended', 'canceled']);
    vi.unstubAllEnvs();
  });
});

describe('coveredUntil e nextPeriodStart', () => {
  it('o próximo período começa no dia seguinte ao fim da cobertura, ou hoje se já venceu', () => {
    expect(coveredUntil(sub({ trial_ends_on: '2026-11-20', paid_until: '2026-11-05', courtesy_until: '2026-11-12' }))).toBe('2026-11-20');
    expect(nextPeriodStart(sub({ trial_ends_on: '2026-11-20' }), today)).toBe('2026-11-21');
    expect(nextPeriodStart(sub({ trial_ends_on: today }), today)).toBe('2026-11-11');
    expect(nextPeriodStart(sub({ trial_ends_on: '2026-11-09' }), today)).toBe(today);
  });
});

describe('isOpenWhenSuspended', () => {
  it.each([
    ['POST', '/api/auth/login', true], ['GET', '/api/auth/me', true], ['POST', '/api/auth/logout', true],
    ['GET', '/api/billing', true], ['GET', '/api/billing/status', true], ['POST', '/api/billing/plan', true], ['POST', '/api/billing/invoices/:id/reported', true],
    ['GET', '/api/account/export', true], ['DELETE', '/api/account/deletion-request', true],
    ['GET', '/api/clinic', true], ['PATCH', '/api/clinic', false], ['GET', '/api/clinic/onboarding', false],
    ['GET', '/api/patients', false], ['POST', '/api/budgets', false], ['GET', '/api/billingx', false], ['GET', '/api/authx/me', false],
  ])('%s %s -> %s', (method, path, open) => {
    expect(isOpenWhenSuspended(method, path)).toBe(open);
  });
});

describe('limite de dentistas do plano', () => {
  const planId = async (code) => (await db('plans').where({ code }).first()).id;
  const onPlan = async (s, code) => db('subscriptions').where({ clinic_id: s.clinic.id }).update({ plan_id: await planId(code) });
  const addUser = (s, role, n) => api().post('/api/users').set(s.headers).send({ name: `Dentista ${n}`, email: `d${n}@plano.test`, password: 'senha-segura-123', role });

  it('no teste (sem plano) não há limite', async () => {
    const s = await setupUser();
    for (let n = 1; n <= 6; n += 1) expect((await addUser(s, 'dentist', n)).status).toBe(201);
  });

  it('plano Essencial: 1 dentista; secretárias e administradores não contam', async () => {
    const s = await setupUser();
    await onPlan(s, 'essencial');
    expect((await addUser(s, 'secretary', 1)).status).toBe(201);
    expect((await addUser(s, 'dentist', 2)).status).toBe(201);
    const blocked = await addUser(s, 'dentist', 3);
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('PLAN_LIMIT');
    expect(blocked.body.error).toContain('Essencial');
    expect(await db('users').where({ clinic_id: s.clinic.id, role: 'dentist' })).toHaveLength(1);
  });

  it('plano Premium não tem limite', async () => {
    const s = await setupUser();
    await onPlan(s, 'premium');
    for (let n = 1; n <= 6; n += 1) expect((await addUser(s, 'dentist', n)).status).toBe(201);
  });

  it('reativar um dentista ou mudar alguém para dentista também respeita o limite', async () => {
    const s = await setupUser();
    const first = await createDentist(s.clinic);
    const second = await createDentist(s.clinic, { active: false });
    const secretary = await createUser(s.clinic, { role: 'secretary' });
    await onPlan(s, 'essencial');
    const patch = (id, body) => api().patch(`/api/users/${id}`).set(s.headers).send(body);

    const reactivate = await patch(second.user.id, { active: true });
    expect(reactivate.status).toBe(422);
    expect(reactivate.body.code).toBe('PLAN_LIMIT');
    expect((await patch(secretary.id, { role: 'dentist' })).status).toBe(422);

    // mexer em quem já é dentista ativo, ou em quem não vira dentista, nunca esbarra no limite
    expect((await patch(first.user.id, { name: 'Dr. Renomeado' })).status).toBe(200);
    expect((await patch(first.user.id, { role: 'dentist', active: true })).status).toBe(200);
    expect((await patch(secretary.id, { name: 'Maria' })).status).toBe(200);
    expect((await patch(first.user.id, { active: false })).status).toBe(200);
    expect((await patch(second.user.id, { active: true })).status).toBe(200); // abriu uma vaga
    expect((await patch('4b1a8b9c-2f3d-4e5a-8c7b-1d2e3f4a5b6c', { active: true })).status).toBe(404);
  });
});

describe('lembretes automáticos x assinatura', () => {
  it('clínica suspensa por falta de pagamento não envia lembretes; em carência ainda envia', async () => {
    const late = await setup();
    const grace = await setup();
    const fine = await setup();
    for (const c of [late, grace, fine]) await appointmentIn(c, 5);
    await db('subscriptions').where({ clinic_id: late.clinic.id }).update({ trial_ends_on: addDays(businessDate(), -20) });
    await db('subscriptions').where({ clinic_id: grace.clinic.id }).update({ trial_ends_on: addDays(businessDate(), -3) });

    const summary = await runReminders();
    expect(summary).toMatchObject({ clinics: 2, sent: 2 });
    expect(sendAppointmentReminderEmail).toHaveBeenCalledTimes(2);
    expect(await db('notifications').where({ clinic_id: late.clinic.id })).toHaveLength(0);
  });
});

describe('matriz: assinatura suspensa', () => {
  it('toda rota da clínica responde 402, menos as liberadas; nada de outra clínica vaza', async () => {
    const { listRoutes } = await import('../src/docs/discover.js');
    const a = await buildClinic('a');
    await db('subscriptions').where({ clinic_id: a.clinic.id }).update({ trial_ends_on: addDays(businessDate(), -40) });
    const routes = listRoutes().filter((r) => r.auth === 'clinic');
    expect(routes.length).toBeGreaterThan(50);
    const { default: app } = await import('../src/app.js');
    const { default: request } = await import('supertest');
    for (const route of routes) {
      const url = route.path.replace(/:\w+/g, '4b1a8b9c-2f3d-4e5a-8c7b-1d2e3f4a5b6c');
      const res = await request(app)[route.method.toLowerCase()](url).set(bearer(a.tokens.admin)).send({});
      if (isOpenWhenSuspended(route.method, route.path)) expect(res.status, `${route.method} ${route.path}`).not.toBe(402);
      else expect(res.status, `${route.method} ${route.path}`).toBe(402);
    }
  }, 120_000);
});
