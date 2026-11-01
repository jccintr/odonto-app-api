// Matriz de segurança: percorre TODAS as rotas e confere quem pode o quê.
// Regra de ouro: rota nova sem entrada em ACCESS faz este teste falhar (a lista vem do próprio Express).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../src/app.js';
import db from '../src/db/knex.js';
import { withTenant } from '../src/db/tenant.js';
import { listRoutes } from '../src/docs/discover.js';
import { signPlatformToken } from '../src/services/tokens.js';
import { createPlatformAdmin } from './helpers/factories.js';
import { ACCESS, RESOURCE, ROLES } from './helpers/access.js';
import { buildClinic, snapshot } from './helpers/fixtures.js';

const discover = () => listRoutes().map((route) => `${route.method} ${route.path}`).sort();

const entries = Object.entries(ACCESS).map(([key, spec]) => ({ key, method: key.split(' ')[0], pattern: key.split(' ')[1], ...spec }));
const clinicRoutes = entries.filter((e) => Array.isArray(e.access));
const platformRoutes = entries.filter((e) => e.access === 'platform');
const publicRoutes = entries.filter((e) => e.access === 'public');

const urlFor = (e, view) => e.pattern.replace(/:(\w+)/g, (_, name) => RESOURCE[e.params[name]](view)) + (e.query ? e.query(view) : '');
const bodyFor = (e, view) => (e.body ? e.body(view) : {});

function call(e, view, token) {
  let req = request(app)[e.method.toLowerCase()](urlFor(e, view));
  if (token) req = req.set('Authorization', `Bearer ${token}`);
  return ['GET', 'DELETE'].includes(e.method) ? req : req.send(bodyFor(e, view));
}

// o dentista 1 enxerga o mundo "como se" os recursos e o dentistId fossem do dentista 2
const asDentist2 = (f) => ({ ...f, d1: f.d2, ...f.second });

describe('mapa de rotas', () => {
  it('toda rota do Express está declarada na tabela de acesso, e a tabela não tem rota que não existe', () => {
    expect(discover()).toEqual(Object.keys(ACCESS).sort());
  });

  it('rotas públicas são só as de entrada e recuperação de conta', () => {
    expect(publicRoutes.map((e) => e.key)).toEqual([
      'POST /api/auth/login', 'POST /api/auth/refresh', 'POST /api/auth/logout', 'POST /api/auth/verify-email',
      'POST /api/auth/resend-verification', 'POST /api/auth/forgot-password', 'POST /api/auth/reset-password', 'POST /api/platform/login',
    ]);
  });
});

describe('sem credencial válida', () => {
  it('toda rota protegida responde 401 sem token, com token lixo, e com token do outro escopo', async () => {
    const a = await buildClinic('a');
    const platformAdmin = await createPlatformAdmin();
    const platformToken = signPlatformToken(platformAdmin);

    for (const e of [...clinicRoutes, ...platformRoutes]) {
      expect((await call(e, a)).status, `${e.key} sem token`).toBe(401);
      expect((await call(e, a, 'lixo.lixo.lixo')).status, `${e.key} token lixo`).toBe(401);
      const wrongScope = e.access === 'platform' ? a.tokens.admin : platformToken;
      expect((await call(e, a, wrongScope)).status, `${e.key} token de outro escopo`).toBe(401);
    }
  }, 120_000);
});

describe('perfis (clínica)', () => {
  it('perfil sem permissão recebe exatamente 403; perfil permitido nunca recebe 401, 403 nem erro 500', async () => {
    const a = await buildClinic('a');
    for (const e of clinicRoutes) {
      for (const role of ROLES) {
        const status = (await call(e, a, a.tokens[role])).status;
        if (e.access.includes(role)) {
          expect([401, 403].includes(status) || status >= 500, `${e.key} como ${role} (permitido) respondeu ${status}`).toBe(false);
        } else {
          expect(status, `${e.key} como ${role} (proibido)`).toBe(403);
        }
      }
    }
  }, 120_000);

  it('a plataforma só aceita token de administrador da plataforma', async () => {
    const a = await buildClinic('a');
    const platformToken = signPlatformToken(await createPlatformAdmin());
    for (const e of platformRoutes) {
      const status = (await call(e, a, platformToken)).status;
      expect([401, 403].includes(status) || status >= 500, `${e.key} respondeu ${status}`).toBe(false);
    }
  }, 120_000);
});

describe('outra clínica', () => {
  it('usar ids de outra clínica sempre dá 404, não muda nada lá e não vaza nenhum dado dela', async () => {
    const a = await buildClinic('a');
    const b = await buildClinic('b');
    const before = await snapshot(b.clinic.id);

    for (const e of clinicRoutes.filter((r) => !r.noRefs && r.access.includes('admin'))) {
      const res = await call(e, b, a.tokens.admin); // admin da A, com todos os ids da B
      expect(res.status, `${e.key} com ids de outra clínica`).toBe(404);
      expect(JSON.stringify(res.body), `${e.key} vazou dado da outra clínica`).not.toContain('SEGREDO-b');
    }

    expect(await snapshot(b.clinic.id)).toEqual(before);
  }, 120_000);

  it('nenhuma resposta, em nenhum perfil, contém dados de outra clínica; e nada muda lá depois de tudo', async () => {
    const a = await buildClinic('a');
    const b = await buildClinic('b');
    const before = await snapshot(b.clinic.id);

    for (const e of clinicRoutes) {
      for (const role of e.access) {
        const res = await call(e, a, a.tokens[role]);
        expect(JSON.stringify(res.body), `${e.key} como ${role}`).not.toContain('SEGREDO-b');
      }
    }
    expect(await snapshot(b.clinic.id)).toEqual(before);
  }, 120_000);

  it('em todas as tabelas com clinic_id, a clínica só enxerga as próprias linhas (vale para tabelas futuras)', async () => {
    const a = await buildClinic('a');
    const b = await buildClinic('b');
    const { rows } = await db.raw("SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'clinic_id' ORDER BY table_name");
    expect(rows.length).toBeGreaterThanOrEqual(12);

    for (const { table_name: table } of rows) {
      const own = (await db(table).where({ clinic_id: a.clinic.id }).count({ n: '*' }).first()).n;
      const visible = await withTenant(a.clinic.id, async (trx) => (await trx(table).count({ n: '*' }).first()).n);
      expect(visible, `tabela ${table}`).toBe(own);
    }
    const visibleClinics = await withTenant(a.clinic.id, (trx) => trx('clinics').select('id'));
    expect(visibleClinics).toEqual([{ id: a.clinic.id }]);
    expect(b.clinic.id).not.toBe(a.clinic.id);
  }, 120_000);
});

describe('dentista (escopo dentro da própria clínica)', () => {
  it('não alcança atendimentos nem orçamentos de outro dentista (404) e não age em nome dele (403)', async () => {
    const a = await buildClinic('a');
    const view = asDentist2(a);
    const token = a.tokens.dentist;

    for (const e of clinicRoutes.filter((r) => r.scoped === 'resource' && r.access.includes('dentist'))) {
      expect((await call(e, view, token)).status, `${e.key} no recurso de outro dentista`).toBe(404);
    }
    for (const e of clinicRoutes.filter((r) => r.scoped === 'create' && r.access.includes('dentist'))) {
      expect((await call(e, view, token)).status, `${e.key} em nome de outro dentista`).toBe(403);
    }
  }, 120_000);

  it('as listas do dentista trazem só o que é dele', async () => {
    const a = await buildClinic('a');
    for (const path of ['/api/appointments', '/api/budgets']) {
      const res = await request(app).get(path).set('Authorization', `Bearer ${a.tokens.dentist}`);
      const ids = res.body.data.map((x) => x.id);
      expect(ids.length, path).toBe(1);
      const own = path.includes('appointments') ? a.appointment.id : a.budget.id;
      const other = path.includes('appointments') ? a.second.appointment.id : a.second.budget.id;
      expect(ids).toContain(own);
      expect(ids).not.toContain(other);
    }
  });

  it('o administrador enxerga os dois dentistas (o escopo é só do perfil dentista)', async () => {
    const a = await buildClinic('a');
    const res = await request(app).get('/api/appointments').set('Authorization', `Bearer ${a.tokens.admin}`);
    expect(res.body.data).toHaveLength(2);
  });
});

describe('estado da conta', () => {
  const states = [
    ['clínica suspensa', 403, (a) => db('clinics').where({ id: a.clinic.id }).update({ status: 'suspended' })],
    ['usuário desativado', 401, (a) => db('users').where({ id: a.admin.id }).update({ active: false })],
    ['senha trocada depois do token', 401, (a) => db('users').where({ id: a.admin.id }).update({ password_changed_at: new Date(Date.now() + 5000) })],
    ['e-mail não verificado', 403, (a) => db('users').where({ id: a.admin.id }).update({ email_verified_at: null })],
    ['usuário apagado', 401, async (a) => {
      await db('users').where({ id: a.admin.id }).update({ role: 'secretary' }); // só para soltar dependências do perfil
      await db('audit_log').where({ user_id: a.admin.id }).del();
      await db('tooth_records').where({ recorded_by: a.admin.id }).del();
      await db('users').where({ id: a.admin.id }).del();
    }],
  ];

  it.each(states)('%s: toda rota da clínica barra o token do usuário (%i)', async (_name, expected, apply) => {
    const a = await buildClinic('a');
    await apply(a);
    for (const e of clinicRoutes) {
      expect((await call(e, a, a.tokens.admin)).status, `${e.key}`).toBe(expected);
    }
  }, 120_000);
});
