// Matriz de segurança: percorre TODAS as rotas e confere quem pode o quê.
// Regra de ouro: rota nova sem entrada em ACCESS faz este teste falhar (a lista vem do próprio Express).
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../src/app.js';
import db from '../src/db/knex.js';
import { withTenant } from '../src/db/tenant.js';
import { MOUNTS } from '../src/routes.js';
import { signPlatformToken } from '../src/services/tokens.js';
import { createPlatformAdmin } from './helpers/factories.js';
import { buildClinic, snapshot } from './helpers/fixtures.js';

const ANY = ['admin', 'secretary', 'dentist'];
const ROLES = ANY;
const CLINICAL = ['admin', 'dentist'];
const FINANCE = ['admin', 'secretary'];
const ADMIN = ['admin'];

// access: 'public' | 'platform' | lista de perfis da clínica que PODEM chamar.
// params: parâmetro da URL -> recurso do fixture. body: monta um corpo VÁLIDO (para o 404/403 vir antes de qualquer 400).
// scoped: 'resource' (dentista só alcança os próprios: 404 no alheio) | 'create' (informa dentistId: 403 se for de outro).
// noRefs: a rota não recebe id de recurso, então não há "id de outra clínica" para tentar.
const ACCESS = {
  // ---- autenticação ----
  'POST /api/auth/login': { access: 'public' },
  'POST /api/auth/refresh': { access: 'public' },
  'POST /api/auth/logout': { access: 'public' },
  'POST /api/auth/verify-email': { access: 'public' },
  'POST /api/auth/resend-verification': { access: 'public' },
  'POST /api/auth/forgot-password': { access: 'public' },
  'POST /api/auth/reset-password': { access: 'public' },
  'GET /api/auth/me': { access: ANY, noRefs: true },
  'POST /api/auth/change-password': { access: ANY, noRefs: true, body: () => ({ currentPassword: 'senha-errada-1', newPassword: 'nova-senha-123' }) },
  // ---- clínica e usuários ----
  'GET /api/clinic': { access: ANY, noRefs: true },
  'PATCH /api/clinic': { access: ADMIN, noRefs: true, body: () => ({ name: 'Clínica Renomeada' }) },
  'GET /api/users': { access: ADMIN, noRefs: true },
  'POST /api/users': { access: ADMIN, noRefs: true, body: (f) => ({ name: 'Novo Usuário', email: `novo.${f.label}@seg.test`, password: 'senha-segura-123', role: 'secretary' }) },
  'GET /api/users/:id': { access: ADMIN, params: { id: 'target' } },
  'PATCH /api/users/:id': { access: ADMIN, params: { id: 'target' }, body: () => ({ name: 'Nome Alterado' }) },
  // ---- dentistas e procedimentos ----
  'GET /api/dentists': { access: ANY, noRefs: true },
  'GET /api/dentists/:id': { access: ANY, params: { id: 'dentist' } },
  'PATCH /api/dentists/:id': { access: ADMIN, params: { id: 'dentist' }, body: () => ({ specialty: 'Ortodontia' }) },
  'GET /api/procedures': { access: ANY, noRefs: true },
  'GET /api/procedures/:id': { access: ANY, params: { id: 'procedure' } },
  'POST /api/procedures': { access: ADMIN, noRefs: true, body: (f) => ({ name: `Novo procedimento ${f.label}` }) },
  'PATCH /api/procedures/:id': { access: ADMIN, params: { id: 'procedure' }, body: () => ({ priceCents: 1 }) },
  // ---- pacientes e odontograma ----
  'GET /api/patients': { access: ANY, noRefs: true },
  'GET /api/patients/:id': { access: ANY, params: { id: 'patient' } },
  'POST /api/patients': { access: ANY, noRefs: true, body: () => ({ name: 'Paciente Novo' }) },
  'PATCH /api/patients/:id': { access: ANY, params: { id: 'patient' }, body: () => ({ notes: 'obs' }) },
  'GET /api/patients/:patientId/odontogram': { access: ANY, params: { patientId: 'patient' } },
  'POST /api/patients/:patientId/odontogram': { access: CLINICAL, params: { patientId: 'patient' }, body: () => ({ tooth: 12, condition: 'caries' }) },
  'DELETE /api/patients/:patientId/odontogram/:recordId': { access: CLINICAL, params: { patientId: 'patient', recordId: 'record' } },
  // ---- agenda ----
  'GET /api/appointments': { access: ANY, noRefs: true },
  'GET /api/appointments/:id': { access: ANY, params: { id: 'appointment' }, scoped: 'resource' },
  'POST /api/appointments': {
    access: ANY, scoped: 'create',
    body: (f) => ({ patientId: f.patient.id, dentistId: f.d1.dentist.id, startsAt: '2099-02-01T10:00:00.000Z', endsAt: '2099-02-01T11:00:00.000Z' }),
  },
  'PATCH /api/appointments/:id': { access: ANY, params: { id: 'appointment' }, scoped: 'resource', body: () => ({ notes: 'obs' }) },
  'POST /api/appointments/:id/status': { access: ANY, params: { id: 'appointment' }, scoped: 'resource', body: () => ({ status: 'confirmed' }) },
  // ---- orçamentos ----
  'GET /api/budgets': { access: ANY, noRefs: true },
  'GET /api/budgets/:id': { access: ANY, params: { id: 'budget' }, scoped: 'resource' },
  'POST /api/budgets': {
    access: CLINICAL, scoped: 'create',
    body: (f) => ({ patientId: f.patient.id, dentistId: f.d1.dentist.id, items: [{ procedureId: f.procedure.id }] }),
  },
  'PATCH /api/budgets/:id': { access: CLINICAL, params: { id: 'budget' }, scoped: 'resource', body: () => ({ notes: 'obs' }) },
  'POST /api/budgets/:id/status': { access: ANY, params: { id: 'budget' }, scoped: 'resource', body: () => ({ status: 'approved' }) },
  'POST /api/budgets/:id/items': { access: CLINICAL, params: { id: 'budget' }, scoped: 'resource', body: (f) => ({ procedureId: f.procedure.id }) },
  'PATCH /api/budgets/:id/items/:itemId': { access: CLINICAL, params: { id: 'budget', itemId: 'item' }, scoped: 'resource', body: () => ({ priceCents: 1 }) },
  'DELETE /api/budgets/:id/items/:itemId': { access: CLINICAL, params: { id: 'budget', itemId: 'item' }, scoped: 'resource' },
  'POST /api/budgets/:id/items/:itemId/perform': { access: CLINICAL, params: { id: 'budget', itemId: 'item' }, scoped: 'resource', body: () => ({}) },
  'POST /api/budgets/:id/items/:itemId/cancel': { access: CLINICAL, params: { id: 'budget', itemId: 'item' }, scoped: 'resource' },
  // ---- financeiro ----
  'GET /api/budgets/:id/payments': { access: FINANCE, params: { id: 'budget' } },
  'POST /api/budgets/:id/payments': { access: FINANCE, params: { id: 'budget' }, body: () => ({ amountCents: 100, dueDate: '2099-01-01' }) },
  'POST /api/budgets/:id/payment-plan': { access: FINANCE, params: { id: 'budget' }, body: () => ({ installments: 1, firstDueDate: '2099-01-01' }) },
  'GET /api/payments': { access: FINANCE, noRefs: true },
  'GET /api/payments/:id': { access: FINANCE, params: { id: 'payment' } },
  'PATCH /api/payments/:id': { access: FINANCE, params: { id: 'payment' }, body: () => ({ notes: 'obs' }) },
  'POST /api/payments/:id/pay': { access: FINANCE, params: { id: 'payment' }, body: () => ({ method: 'cash' }) },
  'POST /api/payments/:id/cancel': { access: FINANCE, params: { id: 'payment' }, body: () => ({}) },
  // ---- plataforma ----
  'POST /api/platform/login': { access: 'public' },
  'GET /api/platform/clinics': { access: 'platform', noRefs: true },
  'POST /api/platform/clinics': {
    access: 'platform', noRefs: true,
    body: (f) => ({ name: `Clínica nova ${f.label}`, admin: { name: 'Admin Novo', email: `admin.novo.${f.label}@seg.test`, password: 'senha-segura-123' } }),
  },
  'GET /api/platform/clinics/:id': { access: 'platform', params: { id: 'clinic' } },
  'PATCH /api/platform/clinics/:id': { access: 'platform', params: { id: 'clinic' }, body: () => ({ plan: 'premium' }) },
};

const RESOURCE = {
  target: (f) => f.target.id, dentist: (f) => f.d1.dentist.id, procedure: (f) => f.procedure.id, patient: (f) => f.patient.id,
  budget: (f) => f.budget.id, item: (f) => f.item.id, appointment: (f) => f.appointment.id, payment: (f) => f.payment.id,
  record: (f) => f.record.id, clinic: (f) => f.clinic.id,
};

// ---- descoberta das rotas (direto do Express) ----
const discover = () =>
  MOUNTS.flatMap(([prefix, router]) =>
    router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) => Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} /api${prefix}${layer.route.path === '/' ? '' : layer.route.path}`)))
  .sort();

const entries = Object.entries(ACCESS).map(([key, spec]) => ({ key, method: key.split(' ')[0], pattern: key.split(' ')[1], ...spec }));
const clinicRoutes = entries.filter((e) => Array.isArray(e.access));
const platformRoutes = entries.filter((e) => e.access === 'platform');
const publicRoutes = entries.filter((e) => e.access === 'public');

const urlFor = (e, view) => e.pattern.replace(/:(\w+)/g, (_, name) => RESOURCE[e.params[name]](view));
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
