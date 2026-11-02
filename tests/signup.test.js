import { afterEach, describe, expect, it, vi } from 'vitest';
import db from '../src/db/knex.js';
import { sendOwnerNotice, sendVerificationEmail } from '../src/services/mailer.js';
import { addDays, businessDate } from '../src/utils/dates.js';
import { LEGAL_VERSION } from '../src/modules/legal/documents.js';
import { TEMPLATES } from '../src/modules/signup/templates.js';
import { api, bearer } from './helpers/factories.js';
import { lastVerificationToken } from './helpers/mail.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const body = (o = {}) => ({
  clinicName: 'Clínica Sorriso Feliz',
  admin: { name: 'Dra. Ana', email: 'Ana@Sorriso.com', password: 'senha-da-ana-123' },
  template: 'general',
  acceptTerms: true,
  ...o,
});
const signup = (o, headers = {}) => api().post('/api/signup').set(headers).send(body(o));

describe('opções do cadastro', () => {
  it('lista modelos, planos, dias de teste e a versão dos termos, sem exigir login', async () => {
    const res = await api().get('/api/signup/options');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ signupEnabled: true, trialDays: 14, legalVersion: LEGAL_VERSION, captchaRequired: false });
    expect(res.body.templates.map((t) => [t.code, t.procedureCount])).toEqual(TEMPLATES.map((t) => [t.code, t.procedures.length]));
    expect(res.body.templates.find((t) => t.code === 'empty').procedureCount).toBe(0);
    expect(res.body.plans.map((p) => p.code)).toEqual(['essencial', 'clinica', 'premium']);
  });

  it('refletem TRIAL_DAYS e o captcha', async () => {
    vi.stubEnv('TRIAL_DAYS', '21');
    vi.stubEnv('TURNSTILE_SECRET', 'segredo');
    const res = await api().get('/api/signup/options');
    expect(res.body).toMatchObject({ trialDays: 21, captchaRequired: true });
  });
});

describe('cadastro de clínica', () => {
  it('cria clínica, administrador, teste grátis, procedimentos do modelo e o aceite dos termos', async () => {
    const res = await signup({}, { 'User-Agent': 'Mozilla/5.0 Teste' });
    expect(res.status).toBe(201);
    expect(res.body.clinic).toMatchObject({ name: 'Clínica Sorriso Feliz', slug: 'clinica-sorriso-feliz', status: 'active' });
    expect(res.body.admin).toMatchObject({ email: 'ana@sorriso.com', role: 'admin', emailVerified: false });
    expect(res.body.trialEndsOn).toBe(addDays(businessDate(), 14));
    expect(res.body.message).toContain('e-mail');

    const clinic = await db('clinics').where({ id: res.body.clinic.id }).first();
    expect(clinic).toMatchObject({ template_code: 'general', prices_reviewed_at: null });
    expect((await db('subscriptions').where({ clinic_id: clinic.id }).first()).trial_ends_on).toBe(addDays(businessDate(), 14));

    const general = TEMPLATES.find((t) => t.code === 'general');
    const procedures = await db('procedures').where({ clinic_id: clinic.id }).orderBy('name');
    expect(procedures).toHaveLength(general.procedures.length);
    expect(procedures.find((p) => p.name === 'Coroa em porcelana')).toMatchObject({ price_cents: 150000, cost_cents: 40000, odontogram_condition: 'crown' });

    const acceptance = await db('terms_acceptances').where({ clinic_id: clinic.id }).first();
    expect(acceptance).toMatchObject({ user_id: res.body.admin.id, terms_version: LEGAL_VERSION, privacy_version: LEGAL_VERSION, user_agent: 'Mozilla/5.0 Teste' });
    expect(acceptance.ip).toBeTruthy();
    expect(acceptance.accepted_at).toBeInstanceOf(Date);

    expect(await db('billing_events').where({ clinic_id: clinic.id, type: 'clinic_created' })).toHaveLength(1);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(sendOwnerNotice).toHaveBeenCalledTimes(1);
    expect(sendOwnerNotice.mock.calls[0][0].text).toContain('Clínica Sorriso Feliz');
  });

  it('o administrador só entra depois de confirmar o e-mail e já enxerga os procedimentos do modelo', async () => {
    await signup({ template: 'orthodontics' });
    const before = await api().post('/api/auth/login').send({ email: 'ana@sorriso.com', password: 'senha-da-ana-123' });
    expect(before.status).toBe(403);
    expect(before.body.code).toBe('EMAIL_NOT_VERIFIED');

    expect((await api().post('/api/auth/verify-email').send({ token: lastVerificationToken() })).status).toBe(200);
    const login = await api().post('/api/auth/login').send({ email: 'ana@sorriso.com', password: 'senha-da-ana-123' });
    expect(login.status).toBe(200);
    const list = await api().get('/api/procedures?perPage=100').set(bearer(login.body.accessToken));
    expect(list.body.total).toBe(TEMPLATES.find((t) => t.code === 'orthodontics').procedures.length);
    expect((await api().get('/api/billing/status').set(bearer(login.body.accessToken))).body.state).toBe('trial');
  });

  it('modelo vazio (padrão) não cria procedimentos; documento é opcional', async () => {
    const res = await signup({ template: undefined, document: '12.345.678/0001-90' });
    expect(res.status).toBe(201);
    expect(res.body.clinic.document).toBe('12.345.678/0001-90');
    expect(await db('procedures').where({ clinic_id: res.body.clinic.id })).toHaveLength(0);
    expect((await db('clinics').where({ id: res.body.clinic.id }).first()).template_code).toBe('empty');
  });

  it('o aceite sem navegador identificado (ausente ou vazio) também é registrado', async () => {
    const mail = (n) => ({ admin: { name: 'Ana', email: `ana${n}@sorriso.com`, password: 'senha-da-ana-123' } });
    expect((await api().post('/api/signup').unset('User-Agent').send(body(mail(1)))).status).toBe(201);
    expect((await api().post('/api/signup').set('User-Agent', '').send(body(mail(2)))).status).toBe(201);
    expect((await db('terms_acceptances').select('user_agent')).map((r) => r.user_agent)).toEqual([null, null]);
  });

  it('nomes iguais ganham identificadores diferentes', async () => {
    const one = await signup({ admin: { name: 'Ana', email: 'ana1@sorriso.com', password: 'senha-da-ana-123' } });
    const two = await signup({ admin: { name: 'Ana', email: 'ana2@sorriso.com', password: 'senha-da-ana-123' } });
    expect([one.body.clinic.slug, two.body.clinic.slug]).toEqual(['clinica-sorriso-feliz', 'clinica-sorriso-feliz-2']);
  });

  it('sem aceitar os termos, com modelo inválido ou dados faltando: 400, e nada é criado', async () => {
    for (const bad of [
      { acceptTerms: false }, { acceptTerms: undefined }, { template: 'dentista-louco' }, { clinicName: 'A' },
      { admin: { name: 'Ana', email: 'nao-e-email', password: 'senha-da-ana-123' } },
      { admin: { name: 'Ana', email: 'ana@x.com', password: 'curta' } },
    ]) {
      expect((await signup(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await db('clinics')).toHaveLength(0);
  });

  it('e-mail já cadastrado: 409 e a clínica não fica pela metade', async () => {
    expect((await signup()).status).toBe(201);
    const again = await signup({ clinicName: 'Outra Clínica' });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain('E-mail');
    expect(await db('clinics')).toHaveLength(1);
    expect(await db('terms_acceptances')).toHaveLength(1);
  });

  it('e-mail temporário é recusado, inclusive os domínios acrescentados em SIGNUP_BLOCKED_DOMAINS', async () => {
    const temp = await signup({ admin: { name: 'Ana', email: 'x@MAILINATOR.com', password: 'senha-da-ana-123' } });
    expect(temp.status).toBe(400);
    expect(temp.body.code).toBe('EMAIL_NOT_ALLOWED');
    vi.stubEnv('SIGNUP_BLOCKED_DOMAINS', 'spam.test, outro.test');
    expect((await signup({ admin: { name: 'Ana', email: 'x@spam.test', password: 'senha-da-ana-123' } })).status).toBe(400);
    expect((await signup({ admin: { name: 'Ana', email: 'x@bom.test', password: 'senha-da-ana-123' } })).status).toBe(201);
  });

  it('cadastro desativado (SIGNUP_ENABLED=false): 403', async () => {
    vi.stubEnv('SIGNUP_ENABLED', 'false');
    const res = await signup();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SIGNUP_DISABLED');
    expect((await api().get('/api/signup/options')).body.signupEnabled).toBe(false);
  });

  it('o limite de cadastros por IP vale (RATE_LIMIT_SIGNUP_MAX)', async () => {
    vi.stubEnv('RATE_LIMIT_ENABLED', 'true');
    vi.stubEnv('RATE_LIMIT_SIGNUP_MAX', '2');
    const mail = (n) => ({ admin: { name: 'Ana', email: `ana${n}@sorriso.com`, password: 'senha-da-ana-123' } });
    expect((await signup(mail(1))).status).toBe(201);
    expect((await signup(mail(2))).status).toBe(201);
    const limited = await signup(mail(3));
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
  });

  it('falha ao avisar o dono ou ao enviar o e-mail não impede o cadastro', async () => {
    sendOwnerNotice.mockRejectedValue(new Error('fora do ar'));
    sendVerificationEmail.mockRejectedValue(new Error('smtp fora do ar'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await signup()).status).toBe(201);
    spy.mockRestore();
  });
});

describe('captcha (Cloudflare Turnstile)', () => {
  it('desligado por padrão; ligado, exige o token e confere com a Cloudflare', async () => {
    vi.stubEnv('TURNSTILE_SECRET', 'segredo-do-turnstile');
    const missing = await signup();
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('CAPTCHA_REQUIRED');

    const fetchMock = vi.fn().mockResolvedValueOnce({ json: async () => ({ success: false }) }).mockResolvedValueOnce({ json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);
    const rejected = await signup({ captchaToken: 'token-ruim' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('CAPTCHA_FAILED');

    const ok = await signup({ captchaToken: 'token-bom' });
    expect(ok.status).toBe(201);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toContain('challenges.cloudflare.com/turnstile');
    expect(init.body.get('secret')).toBe('segredo-do-turnstile');
    expect(init.body.get('response')).toBe('token-bom');
    expect(init.body.get('remoteip')).toBeTruthy();
  });

  it('falha de rede conta como reprovado', async () => {
    vi.stubEnv('TURNSTILE_SECRET', 'segredo');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('sem rede')));
    const res = await signup({ captchaToken: 'qualquer' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CAPTCHA_FAILED');
  });
});

describe('isolamento das clínicas criadas por cadastro', () => {
  it('cada clínica cadastrada só enxerga os próprios procedimentos e usuários', async () => {
    const mk = async (email, template) => {
      const res = await signup({ clinicName: `Clínica ${email}`, template, admin: { name: 'Admin', email, password: 'senha-da-ana-123' } });
      await db('users').where({ id: res.body.admin.id }).update({ email_verified_at: new Date() });
      const login = await api().post('/api/auth/login').send({ email, password: 'senha-da-ana-123' });
      return { ...res.body, headers: bearer(login.body.accessToken) };
    };
    const a = await mk('a@teste-a.com', 'general');
    const b = await mk('b@teste-b.com', 'orthodontics');

    const procA = (await api().get('/api/procedures?perPage=100').set(a.headers)).body;
    const procB = (await api().get('/api/procedures?perPage=100').set(b.headers)).body;
    expect(procA.total).toBe(TEMPLATES[0].procedures.length);
    expect(procB.total).toBe(TEMPLATES[1].procedures.length);
    const idsA = new Set(procA.data.map((p) => p.id));
    expect(procB.data.some((p) => idsA.has(p.id))).toBe(false);

    const usersA = (await api().get('/api/users').set(a.headers)).body;
    expect(usersA.data.map((u) => u.email)).toEqual(['a@teste-a.com']);
    expect((await api().get(`/api/users/${b.admin.id}`).set(a.headers)).status).toBe(404);
    expect((await api().get(`/api/procedures/${procB.data[0].id}`).set(a.headers)).status).toBe(404);
  });
});

describe('textos legais', () => {
  it.each([['terms', 'Termos de Uso'], ['privacy', 'Política de Privacidade']])('%s: documento público e versionado', async (type, title) => {
    const res = await api().get(`/api/legal/${type}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type, title, version: LEGAL_VERSION, updatedOn: LEGAL_VERSION });
    expect(res.body.sections.length).toBeGreaterThanOrEqual(10);
    for (const section of res.body.sections) {
      expect(section.title).toBeTruthy();
      expect(section.paragraphs.length + section.items.length).toBeGreaterThan(0);
    }
  });

  it('os termos refletem a configuração de cobrança e o contato', async () => {
    vi.stubEnv('TRIAL_DAYS', '30');
    vi.stubEnv('BILLING_GRACE_DAYS', '10');
    vi.stubEnv('LEGAL_OPERATOR_NAME', 'Júlio Silva ME');
    vi.stubEnv('LEGAL_CONTACT_EMAIL', 'contato@odontoapp.test');
    const terms = (await api().get('/api/legal/terms')).body;
    const text = JSON.stringify(terms);
    expect(text).toContain('30 dias de teste');
    expect(text).toContain('10 dias de carência');
    expect(text).toContain('Júlio Silva ME');
    expect(text).toContain('contato@odontoapp.test');
    expect(JSON.stringify((await api().get('/api/legal/privacy')).body)).toContain('contato@odontoapp.test');
  });

  it('sem e-mail de contato configurado, aponta os canais do site; usa OWNER_EMAIL se existir', async () => {
    expect(JSON.stringify((await api().get('/api/legal/terms')).body)).toContain('canais de contato');
    vi.stubEnv('OWNER_EMAIL', 'dono@odontoapp.test');
    expect(JSON.stringify((await api().get('/api/legal/terms')).body)).toContain('dono@odontoapp.test');
  });

  it('tipo desconhecido: 400', async () => {
    expect((await api().get('/api/legal/cookies')).status).toBe(400);
  });
});
