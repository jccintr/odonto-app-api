import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from '../src/config/zod.js';
import { errorHandler, notFoundHandler } from '../src/middlewares/error.js';
import { validate } from '../src/middlewares/validate.js';
import { HttpError, notFound } from '../src/utils/errors.js';

const fakeRes = () => {
  const res = { headers: {} };
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.set = vi.fn((k, v) => { res.headers[k] = v; return res; });
  return res;
};
const run = (err) => {
  const res = fakeRes();
  errorHandler(err, {}, res, () => {});
  return res;
};

describe('errorHandler', () => {
  it('HttpError vira JSON com status, mensagem e dados extras', () => {
    const res = run(new HttpError(403, 'Sem acesso', { code: 'X' }));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Sem acesso', code: 'X' });
    expect(res.set).not.toHaveBeenCalled();
  });

  it('429 com retryAfterSeconds define o cabeçalho Retry-After; sem ele, não', () => {
    expect(run(new HttpError(429, 'calma', { retryAfterSeconds: 12 })).headers['Retry-After']).toBe('12');
    expect(run(new HttpError(429, 'calma')).set).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: 'entity.parse.failed' }, 400, 'JSON inválido.'],
    [{ type: 'entity.too.large' }, 413, 'Requisição grande demais.'],
    [{ code: '23505' }, 409, 'Registro duplicado.'],
    [{ code: '23503' }, 409, 'Registro em uso ou referência inválida.'],
    [{ code: '22P02' }, 400, 'Identificador inválido.'],
  ])('erro %j -> %i', (err, status, message) => {
    const res = run(err);
    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith({ error: message });
  });

  it('qualquer outro erro vira 500 genérico e vai para o log, sem vazar detalhes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const err of [new Error('segredo interno'), undefined]) {
      const res = run(err);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Erro interno do servidor.' });
    }
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('notFoundHandler responde 404', () => {
    const res = fakeRes();
    notFoundHandler({}, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Rota não encontrada.' });
  });

  it('erros lançados dentro de handlers assíncronos chegam ao errorHandler (Express 5)', async () => {
    const app = express();
    app.get('/x', async () => { throw notFound('Paciente'); });
    app.use(errorHandler);
    const res = await request(app).get('/x');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Paciente não encontrado(a).');
  });
});

describe('validate', () => {
  const app = express();
  app.use(express.json());
  app.post('/so-body', validate({ body: z.object({ n: z.coerce.number() }) }), (req, res) => res.json(req.valid));
  app.get('/so-query', validate({ query: z.object({ page: z.coerce.number().default(1) }) }), (req, res) => res.json(req.valid));
  app.get('/so-params/:id', validate({ params: z.object({ id: z.uuid() }) }), (req, res) => res.json(req.valid));
  app.post('/tudo/:id', validate({
    params: z.object({ id: z.coerce.number() }), query: z.object({ q: z.string() }), body: z.object({ a: z.object({ b: z.string() }) }),
  }), (req, res) => res.json(req.valid));

  it('entrega os valores convertidos em req.valid, só das partes que têm schema', async () => {
    expect((await request(app).post('/so-body').send({ n: '5' })).body).toEqual({ body: { n: 5 } });
    expect((await request(app).get('/so-query')).body).toEqual({ query: { page: 1 } });
    expect((await request(app).get('/so-params/00000000-0000-4000-8000-000000000000')).body)
      .toEqual({ params: { id: '00000000-0000-4000-8000-000000000000' } });
    expect((await request(app).post('/tudo/7?q=oi').send({ a: { b: 'c' } })).body)
      .toEqual({ params: { id: 7 }, query: { q: 'oi' }, body: { a: { b: 'c' } } });
  });

  it('responde 400 com o caminho de cada campo inválido, inclusive aninhado', async () => {
    const res = await request(app).post('/tudo/abc').send({ a: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Dados inválidos');
    expect(res.body.details).toEqual([{ field: 'id', message: expect.any(String) }]);

    const nested = await request(app).post('/tudo/1?q=x').send({ a: {} });
    expect(nested.body.details[0].field).toBe('a.b');
    expect((await request(app).get('/so-params/abc')).status).toBe(400);
    expect((await request(app).post('/so-body').send({ n: 'x' })).status).toBe(400);
    expect((await request(app).post('/tudo/1').send({ a: { b: 'c' } })).body.details[0].field).toBe('q');
  });
});
