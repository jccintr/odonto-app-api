import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { api, createClinic, createDentist, createUser, setupUser } from './helpers/factories.js';

describe('perfil de dentista (criado pelo banco)', () => {
  it('usuário com perfil dentist ganha o perfil profissional, com os padrões', async () => {
    const { dentist, user } = await createDentist(await createClinic());
    expect(dentist).toMatchObject({ user_id: user.id, cro: null, specialty: null, color: '#0f766e', payout_percent: null });
  });

  it('também nasce quando o dentista é criado ou promovido pela API, sem duplicar', async () => {
    const { headers, clinic } = await setupUser();
    const created = await api().post('/api/users').set(headers).send({ name: 'Dr. Paulo', email: 'paulo@x.com', password: 'senha-do-paulo-1', role: 'dentist' });
    expect(await db('dentists').where({ user_id: created.body.id })).toHaveLength(1);

    const secretary = await createUser(clinic, { role: 'secretary' });
    expect(await db('dentists').where({ user_id: secretary.id })).toHaveLength(0);
    await api().patch(`/api/users/${secretary.id}`).set(headers).send({ role: 'dentist' });
    await api().patch(`/api/users/${secretary.id}`).set(headers).send({ name: 'Outro Nome', role: 'dentist' });
    expect(await db('dentists').where({ user_id: secretary.id })).toHaveLength(1);
  });
});

describe('GET /api/dentists', () => {
  it('qualquer perfil lista os dentistas da própria clínica, em ordem de nome', async () => {
    const { clinic } = await setupUser();
    await createDentist(clinic, { name: 'Zeca', email: 'zeca@x.com' });
    await createDentist(clinic, { name: 'Ana', email: 'ana@x.com' });
    await createDentist(await createClinic(), { name: 'De Outra Clínica' });
    for (const role of ['admin', 'secretary', 'dentist']) {
      const { headers } = await setupUser({ role, clinic });
      const res = await api().get('/api/dentists').set(headers);
      expect(res.status).toBe(200);
      const names = res.body.map((d) => d.name);
      expect(names.filter((n) => ['Ana', 'Zeca'].includes(n))).toEqual(['Ana', 'Zeca']);
      expect(names).not.toContain('De Outra Clínica');
      expect(Object.keys(res.body[0]).sort()).toEqual(['active', 'color', 'cro', 'email', 'id', 'name', 'payoutPercent', 'specialty', 'userId']);
    }
  });

  it('filtra por situação (ativo/desativado)', async () => {
    const { headers, clinic } = await setupUser();
    await createDentist(clinic, { name: 'Ativo' });
    await createDentist(clinic, { name: 'Inativo', active: false });
    const names = async (qs) => (await api().get(`/api/dentists?${qs}`).set(headers)).body.map((d) => d.name);
    expect(await names('active=true')).toEqual(['Ativo']);
    expect(await names('active=false')).toEqual(['Inativo']);
    expect((await api().get('/api/dentists?active=x').set(headers)).status).toBe(400);
  });

  it('exige login (401)', async () => {
    expect((await api().get('/api/dentists')).status).toBe(401);
  });
});

describe('GET /api/dentists/:id', () => {
  it('devolve o dentista da própria clínica; 404 para outra clínica, inexistente ou quem deixou de ser dentista', async () => {
    const { headers, clinic } = await setupUser();
    const { dentist } = await createDentist(clinic);
    const other = await createDentist(await createClinic());
    const demoted = await createDentist(clinic);
    await db('users').where({ id: demoted.user.id }).update({ role: 'secretary' });

    expect((await api().get(`/api/dentists/${dentist.id}`).set(headers)).body.id).toBe(dentist.id);
    expect((await api().get(`/api/dentists/${other.dentist.id}`).set(headers)).status).toBe(404);
    expect((await api().get(`/api/dentists/${demoted.dentist.id}`).set(headers)).status).toBe(404);
    expect((await api().get('/api/dentists/00000000-0000-4000-8000-000000000000').set(headers)).status).toBe(404);
    expect((await api().get('/api/dentists/abc').set(headers)).status).toBe(400);
  });
});

describe('PATCH /api/dentists/:id', () => {
  const patch = (headers, id, body) => api().patch(`/api/dentists/${id}`).set(headers).send(body);

  it('o administrador altera os dados profissionais (percentual volta como número)', async () => {
    const { headers, clinic } = await setupUser();
    const { dentist } = await createDentist(clinic);
    const res = await patch(headers, dentist.id, { cro: 'CRO-MG 12345', specialty: 'Ortodontia', color: '#FF8800', payoutPercent: 40.5 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cro: 'CRO-MG 12345', specialty: 'Ortodontia', color: '#FF8800', payoutPercent: 40.5 });

    const cleared = await patch(headers, dentist.id, { specialty: null, payoutPercent: null });
    expect(cleared.body).toMatchObject({ specialty: null, payoutPercent: null, cro: 'CRO-MG 12345' });
  });

  it('secretária e dentista não alteram (403)', async () => {
    const { clinic } = await setupUser();
    const { dentist } = await createDentist(clinic);
    for (const role of ['secretary', 'dentist']) {
      const { headers } = await setupUser({ role, clinic });
      expect((await patch(headers, dentist.id, { cro: 'CRO-MG 1' })).status).toBe(403);
    }
  });

  it('404 para dentista de outra clínica ou inexistente (e não altera nada lá)', async () => {
    const { headers } = await setupUser();
    const other = await createDentist(await createClinic());
    expect((await patch(headers, other.dentist.id, { cro: 'CRO-MG 999' })).status).toBe(404);
    expect((await db('dentists').where({ id: other.dentist.id }).first()).cro).toBeNull();
    expect((await patch(headers, '00000000-0000-4000-8000-000000000000', { cro: 'CRO-MG 999' })).status).toBe(404);
  });

  it('valida o corpo (400)', async () => {
    const { headers, clinic } = await setupUser();
    const { dentist } = await createDentist(clinic);
    for (const bad of [{}, { color: 'verde' }, { payoutPercent: 101 }, { payoutPercent: -1 }, { cro: 'ab' }, { specialty: 'x'.repeat(81) }]) {
      expect((await patch(headers, dentist.id, bad)).status).toBe(400);
    }
  });
});
