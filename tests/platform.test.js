import { describe, expect, it, vi } from 'vitest';
import db from '../src/db/knex.js';
import { createClinic as createClinicService, createPlatformAdmin } from '../src/modules/platform/platform.service.js';
import { sendVerificationEmail } from '../src/services/mailer.js';
import { api, bearer, createClinic, createDentist, createPatient, createUser, createPlatformAdmin as makeAdmin, PASSWORD, platformSession, setupUser } from './helpers/factories.js';

const newClinic = (o = {}) => ({
  name: 'Clínica Sorriso & Cia',
  admin: { name: 'Dra. Ana', email: 'ana@sorriso.com', password: 'senha-da-ana-123' },
  ...o,
});
const plogin = (body) => api().post('/api/platform/login').send(body);

describe('login da plataforma', () => {
  it('entra com e-mail e senha', async () => {
    const admin = await makeAdmin();
    const res = await plogin({ email: admin.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.admin).toEqual({ id: admin.id, name: admin.name, email: admin.email, active: true });
  });

  it('senha errada, e-mail desconhecido e conta desativada: 401', async () => {
    const admin = await makeAdmin();
    const off = await makeAdmin({ active: false });
    expect((await plogin({ email: admin.email, password: 'errada-errada' })).status).toBe(401);
    expect((await plogin({ email: 'x@y.com', password: PASSWORD })).status).toBe(401);
    expect((await plogin({ email: off.email, password: PASSWORD })).status).toBe(401);
  });

  it('trava depois de 5 erros seguidos (429) e valida o corpo (400)', async () => {
    const admin = await makeAdmin();
    for (let i = 0; i < 5; i += 1) await plogin({ email: admin.email, password: 'errada-errada' });
    const blocked = await plogin({ email: admin.email, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await plogin({})).status).toBe(400);
  });

  it('acertar a senha zera a contagem de erros', async () => {
    const admin = await makeAdmin();
    for (let i = 0; i < 4; i += 1) await plogin({ email: admin.email, password: 'errada-errada' });
    expect((await plogin({ email: admin.email, password: PASSWORD })).status).toBe(200);
    for (let i = 0; i < 4; i += 1) expect((await plogin({ email: admin.email, password: 'errada-errada' })).status).toBe(401);
  });
});

describe('proteção das rotas da plataforma', () => {
  it('401 sem token, com token inválido ou com token de clínica; e o contrário também', async () => {
    const clinicUser = await setupUser();
    const platform = await platformSession();
    expect((await api().get('/api/platform/clinics')).status).toBe(401);
    expect((await api().get('/api/platform/clinics').set(bearer('lixo'))).status).toBe(401);
    expect((await api().get('/api/platform/clinics').set(clinicUser.headers)).status).toBe(401);
    expect((await api().get('/api/auth/me').set(platform.headers)).status).toBe(401);
  });

  it('401 se o administrador foi desativado ou trocou a senha depois do login', async () => {
    const a = await platformSession();
    await db('platform_admins').where({ id: a.admin.id }).update({ active: false });
    expect((await api().get('/api/platform/clinics').set(a.headers)).status).toBe(401);

    const b = await platformSession();
    await db('platform_admins').where({ id: b.admin.id }).update({ password_changed_at: new Date(Date.now() + 5000) });
    expect((await api().get('/api/platform/clinics').set(b.headers)).status).toBe(401);
  });
});

describe('POST /api/platform/clinics', () => {
  it('cria a clínica e o primeiro administrador, que entra depois de verificar o e-mail', async () => {
    const { headers } = await platformSession();
    const res = await api().post('/api/platform/clinics').set(headers).send(newClinic({ document: '12.345.678/0001-90' }));

    expect(res.status).toBe(201);
    expect(res.body.clinic).toMatchObject({ name: 'Clínica Sorriso & Cia', slug: 'clinica-sorriso-cia', plan: 'basic', status: 'active', document: '12.345.678/0001-90' });
    expect(res.body.admin).toMatchObject({ clinicId: res.body.clinic.id, email: 'ana@sorriso.com', role: 'admin', emailVerified: false });
    expect(sendVerificationEmail.mock.calls[0][0]).toMatchObject({ to: 'ana@sorriso.com', name: 'Dra. Ana' });

    // o administrador só entra depois de confirmar o e-mail pelo link
    const login = () => api().post('/api/auth/login').send({ email: 'ana@sorriso.com', password: 'senha-da-ana-123' });
    expect((await login()).body.code).toBe('EMAIL_NOT_VERIFIED');
    const token = new URL(sendVerificationEmail.mock.calls[0][0].url).searchParams.get('token');
    expect((await api().post('/api/auth/verify-email').send({ token })).status).toBe(200);
    const ok = await login();
    expect(ok.status).toBe(200);
    expect(ok.body.clinic.id).toBe(res.body.clinic.id);
  });

  it('gera slug único quando o nome se repete e aceita slug e plano informados', async () => {
    const { headers } = await platformSession();
    const create = (o, n) => api().post('/api/platform/clinics').set(headers)
      .send(newClinic({ admin: { name: 'Ana', email: `a${n}@x.com`, password: 'senha-da-ana-123' }, ...o }));
    expect((await create({}, 1)).body.clinic.slug).toBe('clinica-sorriso-cia');
    expect((await create({}, 2)).body.clinic.slug).toBe('clinica-sorriso-cia-2');
    expect((await create({}, 3)).body.clinic.slug).toBe('clinica-sorriso-cia-3');
    const custom = await create({ slug: 'Minha-Clinica', plan: 'premium' }, 4);
    expect(custom.body.clinic).toMatchObject({ slug: 'minha-clinica', plan: 'premium' });
  });

  it('slug e e-mail repetidos: 409, sem deixar a clínica pela metade', async () => {
    const { headers } = await platformSession();
    await api().post('/api/platform/clinics').set(headers).send(newClinic({ slug: 'sorriso' }));

    const dupSlug = await api().post('/api/platform/clinics').set(headers)
      .send(newClinic({ slug: 'sorriso', admin: { name: 'Bia', email: 'bia@x.com', password: 'senha-da-bia-123' } }));
    expect(dupSlug.status).toBe(409);
    expect(dupSlug.body.error).toMatch(/slug/);

    const dupEmail = await api().post('/api/platform/clinics').set(headers).send(newClinic({ slug: 'outra' }));
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.error).toMatch(/administrador/);

    expect(await db('clinics').count({ n: '*' }).first()).toEqual({ n: '1' });
  });

  it('não falha se o e-mail de verificação não puder ser enviado', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendVerificationEmail.mockRejectedValueOnce(new Error('smtp fora do ar'));
    const { headers } = await platformSession();
    expect((await api().post('/api/platform/clinics').set(headers).send(newClinic())).status).toBe(201);
    spy.mockRestore();
  });

  it('valida o corpo (400), inclusive os campos do administrador', async () => {
    const { headers } = await platformSession();
    const res = await api().post('/api/platform/clinics').set(headers).send({ name: 'C', admin: { name: 'A', email: 'x', password: 'curta' } });
    expect(res.status).toBe(400);
    expect(res.body.details.map((d) => d.field)).toEqual(expect.arrayContaining(['name', 'admin.name', 'admin.email', 'admin.password']));
    expect((await api().post('/api/platform/clinics').set(headers).send(newClinic({ slug: 'Slug Inválido!' }))).status).toBe(400);
  });

  it('erros inesperados do banco continuam subindo (ex.: nome grande demais)', async () => {
    await expect(createClinicService({ name: 'x'.repeat(300), admin: { name: 'Ana', email: 'a@a.com', password: 'senha-da-ana-123' } })).rejects.toThrow();
  });
});

describe('listar, consultar e alterar clínicas', () => {
  it('lista com paginação e filtros por situação e busca (nome ou slug)', async () => {
    const { headers } = await platformSession();
    await createClinic({ name: 'Alfa Odonto', slug: 'alfa' });
    await createClinic({ name: 'Beta Dental', slug: 'beta-sul', status: 'suspended' });
    await createClinic({ name: '100% Sorrisos', slug: 'cem' });
    const names = async (qs) => (await api().get(`/api/platform/clinics?${qs}`).set(headers)).body.data.map((c) => c.name);

    expect(await names('')).toEqual(['100% Sorrisos', 'Alfa Odonto', 'Beta Dental']);
    expect(await names('status=suspended')).toEqual(['Beta Dental']);
    expect(await names('q=odonto')).toEqual(['Alfa Odonto']);
    expect(await names('q=sul')).toEqual(['Beta Dental']);
    expect(await names('q=%25')).toEqual(['100% Sorrisos']);
    const page = await api().get('/api/platform/clinics?perPage=2&page=2').set(headers);
    expect(page.body).toMatchObject({ page: 2, perPage: 2, total: 3, totalPages: 2 });
    expect(page.body.data).toHaveLength(1);
    expect((await api().get('/api/platform/clinics?status=x').set(headers)).status).toBe(400);
  });

  it('consulta uma clínica; 404 se não existir; 400 se o id for inválido', async () => {
    const { headers } = await platformSession();
    const clinic = await createClinic();
    expect((await api().get(`/api/platform/clinics/${clinic.id}`).set(headers)).body.id).toBe(clinic.id);
    expect((await api().get('/api/platform/clinics/00000000-0000-4000-8000-000000000000').set(headers)).status).toBe(404);
    expect((await api().get('/api/platform/clinics/abc').set(headers)).status).toBe(400);
  });

  it('o detalhe da clínica traz só as quantidades de dentistas, secretárias, administradores e pacientes ativos', async () => {
    const { headers } = await platformSession();
    const clinic = await createClinic();
    const other = await createClinic();
    await createDentist(clinic);
    await createDentist(clinic);
    await createDentist(clinic, { active: false });
    await createUser(clinic, { role: 'secretary' });
    await createUser(clinic, { role: 'admin' });
    await createPatient(clinic);
    await createPatient(clinic);
    await createPatient(clinic);
    await createPatient(clinic, { active: false });
    await createDentist(other);
    await createPatient(other);
    const res = await api().get(`/api/platform/clinics/${clinic.id}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.usage).toEqual({ dentists: 2, secretaries: 1, admins: 1, patients: 3 });
    expect((await api().get(`/api/platform/clinics/${other.id}`).set(headers)).body.usage).toEqual({ dentists: 1, secretaries: 0, admins: 0, patients: 1 });
  });

  it('altera nome, documento e plano', async () => {
    const { headers } = await platformSession();
    const clinic = await createClinic();
    const res = await api().patch(`/api/platform/clinics/${clinic.id}`).set(headers).send({ name: 'Nome Novo', document: null, plan: 'premium' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Nome Novo', document: null, plan: 'premium' });
  });

  it('suspender bloqueia a clínica na hora e reativar libera', async () => {
    const { headers } = await platformSession();
    const u = await setupUser();
    const url = `/api/platform/clinics/${u.clinic.id}`;

    await api().patch(url).set(headers).send({ status: 'suspended' });
    const blocked = await api().get('/api/auth/me').set(u.headers);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('CLINIC_SUSPENDED');
    expect((await api().post('/api/auth/login').send({ email: u.user.email, password: PASSWORD })).status).toBe(403);

    await api().patch(url).set(headers).send({ status: 'active' });
    expect((await api().get('/api/auth/me').set(u.headers)).status).toBe(200);
  });

  it('404 ao alterar clínica inexistente e 400 para corpo inválido', async () => {
    const { headers } = await platformSession();
    expect((await api().patch('/api/platform/clinics/00000000-0000-4000-8000-000000000000').set(headers).send({ name: 'Nome Novo' })).status).toBe(404);
    const clinic = await createClinic();
    for (const bad of [{}, { status: 'x' }, { name: 'a' }]) {
      expect((await api().patch(`/api/platform/clinics/${clinic.id}`).set(headers).send(bad)).status).toBe(400);
    }
  });
});

describe('createPlatformAdmin (usado pelo script de linha de comando)', () => {
  it('cria o administrador normalizando o e-mail', async () => {
    const admin = await createPlatformAdmin({ name: 'Julio', email: '  JULIO@Odonto.com ', password: 'senha-do-julio-1' });
    expect(admin).toMatchObject({ name: 'Julio', email: 'julio@odonto.com', active: true });
    expect((await plogin({ email: 'julio@odonto.com', password: 'senha-do-julio-1' })).status).toBe(200);
  });

  it('e-mail repetido: 409; erro inesperado do banco sobe', async () => {
    await createPlatformAdmin({ name: 'Julio', email: 'julio@odonto.com', password: 'senha-do-julio-1' });
    await expect(createPlatformAdmin({ name: 'Outro', email: 'julio@odonto.com', password: 'senha-do-julio-1' })).rejects.toMatchObject({ status: 409 });
    await expect(createPlatformAdmin({ name: 'x'.repeat(300), email: 'z@z.com', password: 'senha-do-julio-1' })).rejects.toThrow();
  });

  it('usuário de clínica com o mesmo e-mail não atrapalha (tabelas separadas)', async () => {
    const user = await createUser(await createClinic());
    const admin = await createPlatformAdmin({ name: 'Julio', email: user.email, password: 'senha-do-julio-1' });
    expect(admin.email).toBe(user.email);
  });
});
