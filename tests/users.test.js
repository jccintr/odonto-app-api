import { describe, expect, it, vi } from 'vitest';
import db from '../src/db/knex.js';
import { createUser as createUserService } from '../src/modules/users/users.service.js';
import { sendVerificationEmail } from '../src/services/mailer.js';
import { api, createClinic, createUser, setupUser } from './helpers/factories.js';
import { lastVerificationToken } from './helpers/mail.js';

const body = (o = {}) => ({ name: 'Maria Souza', email: 'maria@clinica.com', password: 'senha-da-maria-1', role: 'secretary', ...o });

describe('permissões', () => {
  it('só o administrador acessa a gestão de usuários', async () => {
    const { clinic } = await setupUser();
    for (const role of ['secretary', 'dentist']) {
      const { headers } = await setupUser({ role, clinic });
      expect((await api().get('/api/users').set(headers)).status).toBe(403);
      expect((await api().post('/api/users').set(headers).send(body())).status).toBe(403);
    }
    expect((await api().get('/api/users')).status).toBe(401);
  });
});

describe('POST /api/users', () => {
  it('cria o usuário na clínica do administrador, sem expor a senha, e envia o e-mail de verificação', async () => {
    const { headers, clinic } = await setupUser();
    const res = await api().post('/api/users').set(headers).send(body());

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ clinicId: clinic.id, name: 'Maria Souza', email: 'maria@clinica.com', role: 'secretary', active: true, emailVerified: false });
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    expect(sendVerificationEmail.mock.calls[0][0]).toMatchObject({ to: 'maria@clinica.com', name: 'Maria Souza' });
    expect(lastVerificationToken()).toBeTruthy();

    // o novo usuário só entra depois de confirmar o e-mail pelo link
    const login = () => api().post('/api/auth/login').send({ email: 'maria@clinica.com', password: 'senha-da-maria-1' });
    expect((await login()).body.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await api().post('/api/auth/verify-email').send({ token: lastVerificationToken() })).status).toBe(200);
    expect((await login()).status).toBe(200);
  });

  it('normaliza o e-mail', async () => {
    const { headers } = await setupUser();
    const res = await api().post('/api/users').set(headers).send(body({ email: '  MARIA@Clinica.COM ' }));
    expect(res.body.email).toBe('maria@clinica.com');
  });

  it('e-mail repetido: 409, na mesma clínica ou em outra', async () => {
    const a = await setupUser();
    const b = await setupUser();
    expect((await api().post('/api/users').set(a.headers).send(body())).status).toBe(201);
    const same = await api().post('/api/users').set(a.headers).send(body());
    const other = await api().post('/api/users').set(b.headers).send(body());
    expect(same.status).toBe(409);
    expect(same.body.error).toBe('E-mail já cadastrado.');
    expect(other.status).toBe(409);
  });

  it('o cadastro não falha se o e-mail de verificação não puder ser enviado', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendVerificationEmail.mockRejectedValueOnce(new Error('smtp fora do ar'));
    const { headers } = await setupUser();
    expect((await api().post('/api/users').set(headers).send(body())).status).toBe(201);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('valida o corpo (400)', async () => {
    const { headers } = await setupUser();
    for (const bad of [body({ password: 'curta' }), body({ role: 'chefe' }), body({ email: 'x' }), body({ name: '' })]) {
      expect((await api().post('/api/users').set(headers).send(bad)).status).toBe(400);
    }
  });

  it('erros que não são de e-mail repetido continuam subindo (ex.: nome grande demais no banco)', async () => {
    const clinic = await createClinic();
    await expect(createUserService(clinic.id, body({ name: 'x'.repeat(300) }))).rejects.toThrow();
  });
});

describe('GET /api/users', () => {
  const seed = async () => {
    const { headers, clinic } = await setupUser({ userOverrides: { name: 'Admin Zé' } });
    await createUser(clinic, { name: 'Bia Dentista', email: 'bia@x.com', role: 'dentist' });
    await createUser(clinic, { name: 'Carlos Secretário', email: 'carlos@x.com', role: 'secretary', active: false });
    await createUser(clinic, { name: '100% Dentista', email: 'cem@x.com', role: 'dentist' });
    return { headers, clinic };
  };

  it('lista só os usuários da própria clínica, em ordem de nome, com paginação', async () => {
    const { headers } = await seed();
    await setupUser(); // outra clínica: não pode aparecer

    const all = await api().get('/api/users').set(headers);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ page: 1, perPage: 20, total: 4, totalPages: 1 });
    expect(all.body.data.map((u) => u.name)).toEqual(['100% Dentista', 'Admin Zé', 'Bia Dentista', 'Carlos Secretário']);

    const page2 = await api().get('/api/users?perPage=3&page=2').set(headers);
    expect(page2.body).toMatchObject({ page: 2, perPage: 3, total: 4, totalPages: 2 });
    expect(page2.body.data).toHaveLength(1);
  });

  it('filtra por perfil, situação e busca (nome ou e-mail, com % e _ tratados como texto)', async () => {
    const { headers } = await seed();
    const names = async (qs) => (await api().get(`/api/users?${qs}`).set(headers)).body.data.map((u) => u.name);

    expect(await names('role=dentist')).toEqual(['100% Dentista', 'Bia Dentista']);
    expect(await names('active=false')).toEqual(['Carlos Secretário']);
    expect(await names('active=true&role=secretary')).toEqual([]);
    expect(await names('q=bia')).toEqual(['Bia Dentista']);
    expect(await names('q=carlos@x')).toEqual(['Carlos Secretário']);
    expect(await names('q=%25')).toEqual(['100% Dentista']);
    expect(await names('q=_')).toEqual([]);
  });

  it('valida a consulta (400)', async () => {
    const { headers } = await setupUser();
    for (const qs of ['perPage=1000', 'page=0', 'role=chefe', 'active=talvez']) {
      expect((await api().get(`/api/users?${qs}`).set(headers)).status).toBe(400);
    }
  });
});

describe('GET /api/users/:id', () => {
  it('devolve o usuário da própria clínica', async () => {
    const { headers, user } = await setupUser();
    const res = await api().get(`/api/users/${user.id}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
  });

  it('404 para usuário de outra clínica ou inexistente; 400 para id inválido', async () => {
    const a = await setupUser();
    const b = await setupUser();
    expect((await api().get(`/api/users/${b.user.id}`).set(a.headers)).status).toBe(404);
    expect((await api().get('/api/users/00000000-0000-4000-8000-000000000000').set(a.headers)).status).toBe(404);
    expect((await api().get('/api/users/abc').set(a.headers)).status).toBe(400);
  });
});

describe('PATCH /api/users/:id', () => {
  const patch = (headers, id, data) => api().patch(`/api/users/${id}`).set(headers).send(data);

  it('altera nome, perfil e situação de outro usuário', async () => {
    const { headers, clinic } = await setupUser();
    const other = await createUser(clinic, { role: 'secretary' });
    const res = await patch(headers, other.id, { name: 'Novo Nome', role: 'dentist', active: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Novo Nome', role: 'dentist', active: false });
  });

  it('desativar encerra as sessões e bloqueia o acesso do usuário', async () => {
    const { headers, clinic } = await setupUser();
    const other = await setupUser({ role: 'dentist', clinic });
    await patch(headers, other.user.id, { active: false });

    expect((await api().post('/api/auth/refresh').send({ refreshToken: other.session.refreshToken })).status).toBe(401);
    expect((await api().get('/api/auth/me').set(other.headers)).status).toBe(401);
    const active = await db('refresh_tokens').where({ user_id: other.user.id }).whereNull('revoked_at');
    expect(active).toHaveLength(0);
  });

  it('reativar não mexe nas sessões', async () => {
    const { headers, clinic } = await setupUser();
    const other = await createUser(clinic, { active: false });
    expect((await patch(headers, other.id, { active: true })).body.active).toBe(true);
  });

  it('o administrador pode alterar o próprio nome, mas não se desativar nem se rebaixar (422)', async () => {
    const { headers, user } = await setupUser();
    expect((await patch(headers, user.id, { name: 'Outro Nome' })).status).toBe(200);
    expect((await patch(headers, user.id, { role: 'admin' })).status).toBe(200);
    expect((await patch(headers, user.id, { active: true })).status).toBe(200);
    expect((await patch(headers, user.id, { active: false })).status).toBe(422);
    expect((await patch(headers, user.id, { role: 'secretary' })).status).toBe(422);
  });

  it('404 para usuário de outra clínica ou inexistente', async () => {
    const a = await setupUser();
    const b = await setupUser();
    expect((await patch(a.headers, b.user.id, { name: 'Invasor' })).status).toBe(404);
    expect((await db('users').where({ id: b.user.id }).first()).name).toBe(b.user.name);
    expect((await patch(a.headers, '00000000-0000-4000-8000-000000000000', { name: 'Fulano' })).status).toBe(404);
  });

  it('valida o corpo (400): vazio, perfil inválido, tipo errado', async () => {
    const { headers, clinic } = await setupUser();
    const other = await createUser(clinic);
    for (const bad of [{}, { role: 'chefe' }, { active: 'sim' }, { name: 'x' }]) {
      expect((await patch(headers, other.id, bad)).status).toBe(400);
    }
  });
});
