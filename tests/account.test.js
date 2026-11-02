import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { sendOwnerNotice } from '../src/services/mailer.js';
import { addDays, businessDate } from '../src/utils/dates.js';
import { api, bearer, PASSWORD, setupUser } from './helpers/factories.js';
import { buildClinic } from './helpers/fixtures.js';

describe('exportação dos dados (LGPD)', () => {
  it('traz todas as tabelas da clínica, sem senhas nem tokens e sem nada de outra clínica', async () => {
    const a = await buildClinic('a');
    await buildClinic('b');
    const res = await api().get('/api/account/export').set(bearer(a.tokens.admin));
    expect(res.status).toBe(200);
    expect(res.body.clinic.id).toBe(a.clinic.id);
    expect(new Date(res.body.exportedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);

    const { tables } = res.body;
    for (const name of ['users', 'patients', 'appointments', 'budgets', 'budget_items', 'payments', 'procedures', 'subscriptions', 'invoices', 'payouts']) {
      expect(tables[name], name).toBeDefined();
      expect(tables[name].length, name).toBeGreaterThan(0);
    }
    expect(Object.keys(tables)).not.toContain('refresh_tokens');
    expect(Object.keys(tables)).not.toContain('auth_tokens');
    expect(tables.patients[0].name).toBe('SEGREDO-a-paciente');

    const text = JSON.stringify(res.body);
    expect(text).not.toContain('SEGREDO-b');
    expect(text).not.toContain('password_hash');
    expect(text).not.toContain('token_hash');
    for (const user of tables.users) expect(user).not.toHaveProperty('password_hash');
  });

  it('só o administrador exporta', async () => {
    const a = await buildClinic('a');
    for (const role of ['secretary', 'dentist']) {
      expect((await api().get('/api/account/export').set(bearer(a.tokens[role]))).status, role).toBe(403);
    }
  });

  it('continua funcionando com a assinatura suspensa', async () => {
    const s = await setupUser();
    await db('subscriptions').where({ clinic_id: s.clinic.id }).update({ trial_ends_on: addDays(businessDate(), -40) });
    expect((await api().get('/api/patients').set(s.headers)).status).toBe(402);
    expect((await api().get('/api/account/export').set(s.headers)).status).toBe(200);
  });
});

describe('pedido de exclusão da conta', () => {
  const request = (s, password = PASSWORD) => api().post('/api/account/deletion-request').set(s.headers).send({ password });

  it('exige a senha do administrador', async () => {
    const s = await setupUser();
    const wrong = await request(s, 'senha-errada-123');
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('WRONG_PASSWORD');
    expect((await api().post('/api/account/deletion-request').set(s.headers).send({})).status).toBe(400);
    expect((await db('subscriptions').where({ clinic_id: s.clinic.id }).first()).deletion_requested_at).toBeNull();
    expect(sendOwnerNotice).not.toHaveBeenCalled();
  });

  it('registra o pedido, avisa o dono uma única vez e aparece na assinatura', async () => {
    const s = await setupUser();
    await db('clinics').where({ id: s.clinic.id }).update({ name: 'Clínica Despedida' });
    const first = await request(s);
    expect(first.status).toBe(200);
    expect(first.body.deletionRequestedAt).toBeTruthy();
    expect(sendOwnerNotice).toHaveBeenCalledTimes(1);
    expect(sendOwnerNotice.mock.calls[0][0].text).toContain('Clínica Despedida');

    const again = await request(s);
    expect(again.body.deletionRequestedAt).toBe(first.body.deletionRequestedAt);
    expect(sendOwnerNotice).toHaveBeenCalledTimes(1);
    expect(await db('billing_events').where({ clinic_id: s.clinic.id, type: 'deletion_requested' })).toHaveLength(1);
    expect((await api().get('/api/billing').set(s.headers)).body.deletionRequestedAt).toBe(first.body.deletionRequestedAt);
  });

  it('o administrador pode cancelar o pedido', async () => {
    const s = await setupUser();
    await request(s);
    const res = await api().delete('/api/account/deletion-request').set(s.headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deletionRequestedAt: null });
    expect(await db('billing_events').where({ clinic_id: s.clinic.id, type: 'deletion_canceled' })).toHaveLength(1);
  });

  it('com a assinatura suspensa o pedido ainda é aceito', async () => {
    const s = await setupUser();
    await db('subscriptions').where({ clinic_id: s.clinic.id }).update({ trial_ends_on: addDays(businessDate(), -40) });
    expect((await request(s)).status).toBe(200);
  });
});
