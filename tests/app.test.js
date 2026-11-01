import net from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import db from '../src/db/knex.js';
import { api } from './helpers/factories.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('rotas básicas', () => {
  it('GET / identifica a API', async () => {
    const res = await api().get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'OdontoApp API', status: 'ok' });
  });

  it('GET /health confere o banco', async () => {
    const ok = await api().get('/health');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'ok', database: 'up' });
  });

  it('GET /health responde 503 com o banco fora do ar', async () => {
    vi.spyOn(db, 'raw').mockRejectedValueOnce(new Error('sem conexão'));
    const res = await api().get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error', database: 'down' });
  });

  it('rota inexistente: 404 em JSON', async () => {
    for (const url of ['/nada', '/api/nada']) {
      const res = await api().get(url);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Rota não encontrada.' });
    }
  });

  it('JSON malformado: 400; corpo grande demais: 413', async () => {
    const bad = await api().post('/api/auth/login').set('Content-Type', 'application/json').send('{ quebrado');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('JSON inválido.');

    const big = await api().post('/api/auth/login').send({ email: 'a@a.com', password: 'x'.repeat(2 * 1024 * 1024) });
    expect(big.status).toBe(413);
  });

  it('cabeçalhos de segurança (helmet) e sem x-powered-by', async () => {
    const res = await api().get('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('CORS', () => {
  it('sem CORS_ORIGINS, aceita qualquer origem (o acesso é por token)', async () => {
    const res = await api().get('/').set('Origin', 'https://qualquer.com');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    const preflight = await api().options('/api/auth/login').set('Origin', 'https://qualquer.com').set('Access-Control-Request-Method', 'POST');
    expect(preflight.status).toBe(204);
  });

  it('com CORS_ORIGINS, só as origens da lista recebem o cabeçalho', async () => {
    vi.stubEnv('CORS_ORIGINS', 'https://app.odonto.com.br,https://admin.odonto.com.br');
    vi.resetModules();
    const { default: restricted } = await import('../src/app.js');
    const { default: freshDb } = await import('../src/db/knex.js');

    const allowed = await request(restricted).get('/').set('Origin', 'https://app.odonto.com.br');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.odonto.com.br');
    const denied = await request(restricted).get('/').set('Origin', 'https://invasor.com');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    await freshDb.destroy();
  });
});

describe('proxy', () => {
  it('em produção confia em 1 salto de proxy (IP real do cliente nos limites)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { default: app } = await import('../src/app.js');
    const { default: freshDb } = await import('../src/db/knex.js');
    expect(app.get('trust proxy')).toBe(1);
    await freshDb.destroy();
  });
});

const freePort = () => new Promise((resolve) => {
  const server = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

describe('main.start', () => {
  const quiet = () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    return vi.spyOn(console, 'warn').mockImplementation(() => {});
  };

  it('confere o banco, sobe o servidor e desliga limpo', async () => {
    const warn = quiet();
    const port = await freePort();
    vi.stubEnv('PORT', String(port));
    vi.resetModules();
    const { start } = await import('../src/main.js');

    const { server, stop } = await start();
    expect(server.listening).toBe(true);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await res.json()).toEqual({ status: 'ok', database: 'up' });
    expect(warn).not.toHaveBeenCalled();

    await stop();
    expect(server.listening).toBe(false);
  });

  it('liga o agendador dos lembretes só com REMINDERS_SCHEDULER=true e o desliga junto com o servidor', async () => {
    quiet();
    const stopScheduler = vi.fn();
    const startReminderScheduler = vi.fn(() => stopScheduler);
    vi.doMock('../src/services/scheduler.js', () => ({ startReminderScheduler }));
    vi.stubEnv('PORT', String(await freePort()));
    vi.resetModules();
    const { start } = await import('../src/main.js');

    await (await start()).stop();
    expect(startReminderScheduler).not.toHaveBeenCalled();

    vi.stubEnv('REMINDERS_SCHEDULER', 'true');
    vi.stubEnv('PORT', String(await freePort()));
    vi.resetModules(); // o primeiro stop() encerrou o pool do banco: recarrega para subir de novo
    const { stop } = await (await import('../src/main.js')).start();
    expect(startReminderScheduler).toHaveBeenCalledTimes(1);
    await stop();
    expect(stopScheduler).toHaveBeenCalledTimes(1);
    vi.doUnmock('../src/services/scheduler.js');
  });

  it('avisa quando os dois segredos de JWT são iguais', async () => {
    const warn = quiet();
    vi.stubEnv('PORT', String(await freePort()));
    vi.stubEnv('JWT_SECRET_PLATFORM', 'segredo-de-teste');
    vi.resetModules();
    const { start } = await import('../src/main.js');
    const { stop } = await start();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('JWT_SECRET igual a JWT_SECRET_PLATFORM'));
    await stop();
  });

  it('não sobe sem JWT_SECRET', async () => {
    vi.stubEnv('JWT_SECRET', '');
    vi.resetModules();
    const { start } = await import('../src/main.js');
    await expect(start()).rejects.toThrow('JWT_SECRET');
  });

  it('não sobe se o banco não responde', async () => {
    quiet();
    vi.stubEnv('DATABASE_URL', 'postgres://x:y@127.0.0.1:1/nada');
    vi.resetModules();
    const { start } = await import('../src/main.js');
    const { default: freshDb } = await import('../src/db/knex.js');
    await expect(start()).rejects.toThrow();
    await freshDb.destroy();
  });
});
