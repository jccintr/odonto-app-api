import { describe, expect, it } from 'vitest';
import { createProcedure as createProcedureService, updateProcedure as updateProcedureService } from '../src/modules/procedures/procedures.service.js';
import { api, createClinic, setupUser } from './helpers/factories.js';

const create = (headers, body) => api().post('/api/procedures').set(headers).send(body);

describe('POST /api/procedures', () => {
  it('o administrador cadastra procedimentos (preço em centavos; padrão 0)', async () => {
    const { headers } = await setupUser();
    const res = await create(headers, { name: 'Limpeza', category: 'Prevenção', priceCents: 15000 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Limpeza', category: 'Prevenção', priceCents: 15000, active: true });

    const bare = await create(headers, { name: 'Consulta' });
    expect(bare.body).toMatchObject({ category: null, priceCents: 0 });
  });

  it('condição do odontograma (marcada no dente quando o procedimento é realizado): opcional e validada', async () => {
    const { headers } = await setupUser();
    const ok = await create(headers, { name: 'Restauração', odontogramCondition: 'restoration' });
    expect(ok.body.odontogramCondition).toBe('restoration');
    expect((await create(headers, { name: 'Consulta' })).body.odontogramCondition).toBeNull();
    expect((await create(headers, { name: 'Outro', odontogramCondition: null })).body.odontogramCondition).toBeNull();
    expect((await create(headers, { name: 'Inválido', odontogramCondition: 'dor' })).status).toBe(400);

    const patch = (body) => api().patch(`/api/procedures/${ok.body.id}`).set(headers).send(body);
    expect((await patch({ odontogramCondition: 'crown' })).body.odontogramCondition).toBe('crown');
    expect((await patch({ odontogramCondition: null })).body.odontogramCondition).toBeNull();
    expect((await patch({ odontogramCondition: 'x' })).status).toBe(400);
  });

  it('nome repetido na mesma clínica: 409; em outra clínica pode', async () => {
    const a = await setupUser();
    const b = await setupUser();
    await create(a.headers, { name: 'Limpeza' });
    const dup = await create(a.headers, { name: 'Limpeza' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('Já existe um procedimento com este nome.');
    expect((await create(b.headers, { name: 'Limpeza' })).status).toBe(201);
  });

  it('secretária e dentista não cadastram (403)', async () => {
    const { clinic } = await setupUser();
    for (const role of ['secretary', 'dentist']) {
      const { headers } = await setupUser({ role, clinic });
      expect((await create(headers, { name: 'Limpeza' })).status).toBe(403);
    }
  });

  it('erros inesperados do banco continuam subindo (ex.: nome grande demais)', async () => {
    const { clinic } = await setupUser();
    await expect(createProcedureService(clinic.id, { name: 'x'.repeat(300), priceCents: 0 })).rejects.toThrow();
    const proc = (await createProcedureService(clinic.id, { name: 'Limpeza', priceCents: 0 }));
    await expect(updateProcedureService(clinic.id, proc.id, { name: 'x'.repeat(300) })).rejects.toThrow();
  });

  it('valida o corpo (400): nome curto, valor negativo, fracionado ou alto demais', async () => {
    const { headers } = await setupUser();
    for (const bad of [{ name: 'x' }, { name: 'Ok', priceCents: -1 }, { name: 'Ok', priceCents: 10.5 }, { name: 'Ok', priceCents: 200_000_000 }, { name: 'Ok', category: 'x'.repeat(81) }]) {
      expect((await create(headers, bad)).status).toBe(400);
    }
  });
});

describe('GET /api/procedures', () => {
  const seed = async () => {
    const { headers, clinic } = await setupUser();
    await create(headers, { name: 'Restauração', category: 'Dentística', priceCents: 20000 });
    await create(headers, { name: 'Canal', category: 'Endodontia', priceCents: 60000 });
    const old = await create(headers, { name: 'Antigo', category: 'Dentística' });
    await api().patch(`/api/procedures/${old.body.id}`).set(headers).send({ active: false });
    return { headers, clinic };
  };

  it('todos os perfis consultam, em ordem de nome, só da própria clínica', async () => {
    const { clinic } = await seed();
    const { headers: other } = await setupUser(); // outra clínica
    await create(other, { name: 'De Outra Clínica' });
    for (const role of ['admin', 'secretary', 'dentist']) {
      const { headers } = await setupUser({ role, clinic });
      const res = await api().get('/api/procedures').set(headers);
      expect(res.body.data.map((p) => p.name)).toEqual(['Antigo', 'Canal', 'Restauração']);
      expect(res.body).toMatchObject({ page: 1, perPage: 20, total: 3, totalPages: 1 });
    }
  });

  it('filtra por situação e busca (nome ou categoria) e pagina', async () => {
    const { headers } = await seed();
    const names = async (qs) => (await api().get(`/api/procedures?${qs}`).set(headers)).body.data.map((p) => p.name);
    expect(await names('active=true')).toEqual(['Canal', 'Restauração']);
    expect(await names('active=false')).toEqual(['Antigo']);
    expect(await names('q=xyz')).toEqual([]);
    expect(await names('q=canal')).toEqual(['Canal']);
    expect(await names('q=dentística')).toEqual(['Antigo', 'Restauração']);
    expect(await names('q=%25')).toEqual([]);
    const page = await api().get('/api/procedures?perPage=2&page=2').set(headers);
    expect(page.body).toMatchObject({ page: 2, perPage: 2, total: 3, totalPages: 2 });
    expect(page.body.data).toHaveLength(1);
    expect((await api().get('/api/procedures?perPage=500').set(headers)).status).toBe(400);
  });
});

describe('GET e PATCH /api/procedures/:id', () => {
  it('consulta; 404 para outra clínica ou inexistente; 400 para id inválido', async () => {
    const a = await setupUser();
    const b = await setupUser();
    const proc = (await create(a.headers, { name: 'Limpeza' })).body;
    expect((await api().get(`/api/procedures/${proc.id}`).set(a.headers)).body.name).toBe('Limpeza');
    expect((await api().get(`/api/procedures/${proc.id}`).set(b.headers)).status).toBe(404);
    expect((await api().get('/api/procedures/00000000-0000-4000-8000-000000000000').set(a.headers)).status).toBe(404);
    expect((await api().get('/api/procedures/abc').set(a.headers)).status).toBe(400);
  });

  it('o administrador altera nome, categoria, preço e situação', async () => {
    const { headers } = await setupUser();
    const proc = (await create(headers, { name: 'Limpeza', category: 'Prevenção', priceCents: 100 })).body;
    const patch = (body) => api().patch(`/api/procedures/${proc.id}`).set(headers).send(body);

    expect((await patch({ name: 'Profilaxia' })).body).toMatchObject({ name: 'Profilaxia', priceCents: 100 });
    expect((await patch({ priceCents: 0, category: null })).body).toMatchObject({ priceCents: 0, category: null });
    expect((await patch({ active: false })).body.active).toBe(false);
  });

  it('nome repetido: 409; 404 para outra clínica; 403 para quem não é administrador; 400 para corpo inválido', async () => {
    const a = await setupUser();
    const b = await setupUser();
    const first = (await create(a.headers, { name: 'Limpeza' })).body;
    const second = (await create(a.headers, { name: 'Canal' })).body;
    expect((await api().patch(`/api/procedures/${second.id}`).set(a.headers).send({ name: 'Limpeza' })).status).toBe(409);
    expect((await api().patch(`/api/procedures/${first.id}`).set(b.headers).send({ name: 'Invasor' })).status).toBe(404);
    expect((await api().patch('/api/procedures/00000000-0000-4000-8000-000000000000').set(a.headers).send({ name: 'Nada' })).status).toBe(404);

    const secretary = await setupUser({ role: 'secretary', clinic: a.clinic });
    expect((await api().patch(`/api/procedures/${first.id}`).set(secretary.headers).send({ name: 'Outro' })).status).toBe(403);
    for (const bad of [{}, { priceCents: -5 }, { active: 'sim' }]) {
      expect((await api().patch(`/api/procedures/${first.id}`).set(a.headers).send(bad)).status).toBe(400);
    }
  });

  it('exige login (401)', async () => {
    expect((await api().get('/api/procedures')).status).toBe(401);
    expect(await createClinic()).toBeTruthy();
  });
});
