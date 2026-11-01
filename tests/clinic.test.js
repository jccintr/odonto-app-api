import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { api, setupUser } from './helpers/factories.js';

describe('GET /api/clinic', () => {
  it('qualquer perfil vê a própria clínica', async () => {
    const { clinic } = await setupUser();
    for (const role of ['admin', 'secretary', 'dentist']) {
      const { headers } = await setupUser({ role, clinic });
      const res = await api().get('/api/clinic').set(headers);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: clinic.id, name: clinic.name, slug: clinic.slug, status: 'active' });
    }
  });

  it('exige login (401)', async () => {
    expect((await api().get('/api/clinic')).status).toBe(401);
  });
});

describe('PATCH /api/clinic', () => {
  it('o administrador altera nome e documento só da própria clínica', async () => {
    const a = await setupUser();
    const b = await setupUser();
    const res = await api().patch('/api/clinic').set(a.headers).send({ name: 'Clínica Sorriso', document: '12.345.678/0001-90' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Clínica Sorriso', document: '12.345.678/0001-90' });
    expect((await db('clinics').where({ id: b.clinic.id }).first()).name).toBe(b.clinic.name);

    const cleared = await api().patch('/api/clinic').set(a.headers).send({ document: null });
    expect(cleared.body.document).toBeNull();
  });

  it('secretária e dentista não alteram (403)', async () => {
    const { clinic } = await setupUser();
    for (const role of ['secretary', 'dentist']) {
      const { headers } = await setupUser({ role, clinic });
      expect((await api().patch('/api/clinic').set(headers).send({ name: 'Outro Nome' })).status).toBe(403);
    }
  });

  it('valida o corpo (400): vazio, nome curto, documento grande', async () => {
    const { headers } = await setupUser();
    for (const bad of [{}, { name: 'x' }, { document: 'x'.repeat(21) }]) {
      expect((await api().patch('/api/clinic').set(headers).send(bad)).status).toBe(400);
    }
  });

  it('não permite trocar plano nem situação (campos desconhecidos são ignorados)', async () => {
    const { headers, clinic } = await setupUser();
    await api().patch('/api/clinic').set(headers).send({ name: 'Nome Novo', plan: 'premium', status: 'suspended' });
    const row = await db('clinics').where({ id: clinic.id }).first();
    expect(row).toMatchObject({ plan: 'basic', status: 'active' });
  });
});
