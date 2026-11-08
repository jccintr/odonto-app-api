import SwaggerParser from '@apidevtools/swagger-parser';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/app.js';
import { DOCS } from '../src/docs/descriptions.js';
import { listRoutes } from '../src/docs/discover.js';
import { buildOpenApi, cleanSchema } from '../src/docs/openapi.js';
import { ACCESS, ANY } from './helpers/access.js';

afterEach(() => vi.unstubAllEnvs());

const spec = buildOpenApi();
const operations = Object.entries(spec.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, operation]) => ({ path, method, operation })));

describe('especificação OpenAPI', () => {
  it('é um documento OpenAPI 3.1 válido', async () => {
    expect(spec.openapi).toBe('3.1.0');
    await expect(SwaggerParser.validate(structuredClone(spec))).resolves.toBeTruthy();
  });

  it('documenta exatamente as rotas que existem, cada uma com resumo, tag e segurança', () => {
    const real = listRoutes().map((r) => `${r.method} ${r.path}`).sort();
    expect(Object.keys(DOCS).sort()).toEqual(real);
    expect(operations).toHaveLength(real.length);
    const tags = new Set(spec.tags.map((t) => t.name));
    for (const { path, method, operation } of operations) {
      expect(operation.summary, `${method} ${path}`).toBeTruthy();
      expect(tags.has(operation.tags[0]), `${method} ${path}: tag ${operation.tags[0]}`).toBe(true);
      expect(Array.isArray(operation.security)).toBe(true);
    }
  });

  it('operationIds são únicos', () => {
    const ids = operations.map((o) => o.operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('autenticação, perfis e entrada documentados batem com o que o código e a matriz de segurança esperam', () => {
    for (const route of listRoutes()) {
      const key = `${route.method} ${route.path}`;
      const operation = spec.paths[route.openApiPath][route.method.toLowerCase()];
      const expected = ACCESS[key].access;
      if (expected === 'public') {
        expect(route.auth, key).toBeNull();
        expect(operation.security, key).toEqual([]);
      } else if (expected === 'platform') {
        expect(route.auth, key).toBe('platform');
        expect(operation.security, key).toEqual([{ platformBearer: [] }]);
      } else {
        expect(route.auth, key).toBe('clinic');
        expect([...(route.roles ?? ANY)].sort(), `${key}: perfis no código x na matriz`).toEqual([...expected].sort());
        expect(operation.security, key).toEqual([{ clinicBearer: [] }]);
      }
      const hasBody = Boolean(route.schemas.body);
      expect(Boolean(operation.requestBody), `${key} corpo`).toBe(hasBody);
    }
  });

  it('parâmetros de URL e de consulta vêm dos schemas de validação', () => {
    const list = spec.paths['/api/payments'].get;
    const names = list.parameters.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['page', 'perPage', 'status', 'method', 'patientId', 'budgetId', 'dueFrom', 'dueTo', 'overdue']));
    expect(list.parameters.every((p) => p.in === 'query' && p.required === false)).toBe(true);

    const detail = spec.paths['/api/budgets/{id}/items/{itemId}'].patch;
    expect(detail.parameters.map((p) => [p.name, p.in, p.required])).toEqual([['id', 'path', true], ['itemId', 'path', true]]);
    expect(detail.requestBody.content['application/json'].schema.properties).toHaveProperty('tooth');
  });

  it('descreve quem pode chamar e os erros padrão de cada rota', () => {
    const cancel = spec.paths['/api/payments/{id}/cancel'].post;
    expect(cancel.description).toContain('Acesso: administrador, secretária.');
    expect(Object.keys(cancel.responses).sort()).toEqual(['200', '400', '401', '402', '403', '404', '409', '413', '429', '500']);

    const login = spec.paths['/api/auth/login'].post;
    expect(login.description).toContain('Acesso: público');
    expect(Object.keys(login.responses)).toEqual(expect.arrayContaining(['200', '400', '401', '403', '413', '429']));

    expect(spec.paths['/api/clinic'].get.description).toContain('administrador, secretária, dentista');
    expect(spec.paths['/api/platform/clinics'].get.description).toContain('administradores da plataforma');
    expect(spec.paths['/api/auth/logout'].post.responses['204'].content).toBeUndefined();
  });

  it('os schemas de resposta referenciados existem', () => {
    const referenced = new Set(JSON.stringify(spec).match(/#\/components\/schemas\/(\w+)/g).map((r) => r.split('/').pop()));
    for (const name of referenced) expect(spec.components.schemas, name).toHaveProperty(name);
  });
});

describe('buildOpenApi', () => {
  it('falha se uma rota ficar sem documentação ou se sobrar texto de rota que não existe', () => {
    const routes = listRoutes();
    const { 'GET /api/clinic': _removed, ...withoutClinic } = DOCS;
    expect(() => buildOpenApi({ routes, docs: withoutClinic })).toThrow('Rota sem documentação: GET /api/clinic');
    expect(() => buildOpenApi({ routes, docs: { ...DOCS, 'GET /api/fantasma': { summary: 'x', status: 200 } } })).toThrow('Documentação de rota que não existe: GET /api/fantasma');
  });

  it('cleanSchema tira o $schema, padrões de datas/uuid e o máximo inteiro, e preserva o resto', () => {
    const cleaned = cleanSchema({
      $schema: 'x', type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid', pattern: '^enorme$' }, nome: { type: 'string', pattern: '^[a-z]+$' },
        n: { type: 'integer', maximum: Number.MAX_SAFE_INTEGER }, limite: { type: 'integer', maximum: 100 },
        nada: null, lista: [1, 'a'],
      },
    });
    expect(cleaned).toEqual({
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' }, nome: { type: 'string', pattern: '^[a-z]+$' }, n: { type: 'integer' }, limite: { type: 'integer', maximum: 100 }, nada: null, lista: [1, 'a'] },
    });
  });
});

describe('/docs e /openapi.json', () => {
  it('serve a especificação e a interface do Swagger UI', async () => {
    const json = await request(app).get('/openapi.json');
    expect(json.status).toBe(200);
    expect(json.body.info.title).toBe('OdontoApp API');
    expect(Object.keys(json.body.paths)).toHaveLength(Object.keys(spec.paths).length);

    const ui = await request(app).get('/docs/');
    expect(ui.status).toBe(200);
    expect(ui.text).toContain('swagger-ui');
  });

  it('DOCS_ENABLED=false desliga a documentação', async () => {
    vi.stubEnv('DOCS_ENABLED', 'false');
    vi.resetModules();
    const { default: noDocsApp } = await import('../src/app.js');
    const { default: freshDb } = await import('../src/db/knex.js');
    expect((await request(noDocsApp).get('/openapi.json')).status).toBe(404);
    expect((await request(noDocsApp).get('/docs/')).status).toBe(404);
    await freshDb.destroy();
  });
});
