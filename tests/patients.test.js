import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { withTenant } from '../src/db/tenant.js';
import { createPatient as createPatientService, updatePatient as updatePatientService } from '../src/modules/patients/patients.service.js';
import { api, createClinic, createPatient, setupUser } from './helpers/factories.js';

const CPF = '52998224725'; // CPFs válidos de teste
const CPF2 = '11144477735';
const create = (headers, body) => api().post('/api/patients').set(headers).send(body);
const patch = (headers, id, body) => api().patch(`/api/patients/${id}`).set(headers).send(body);
const audit = (clinicId, entityId) => db('audit_log').where({ clinic_id: clinicId, entity_id: entityId }).orderBy('created_at');

describe('POST /api/patients', () => {
  it('cadastro mínimo (só o nome): valores padrão e registro de auditoria', async () => {
    const { headers, user, clinic } = await setupUser();
    const res = await create(headers, { name: 'Maria da Silva' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Maria da Silva', cpf: null, birthDate: null, phone: null, email: null, anamnesis: {}, notes: null,
      contactConsent: false, consentAt: null, active: true,
      address: { zip: null, street: null, number: null, complement: null, district: null, city: null, state: null },
    });
    const rows = await audit(clinic.id, res.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: user.id, entity: 'patient', action: 'create', changes: null });
    expect((await db('patients').where({ id: res.body.id }).first()).created_by).toBe(user.id);
  });

  it('cadastro completo: máscaras removidas, e-mail e UF normalizados, aceite de contato com data', async () => {
    const { headers } = await setupUser();
    const res = await create(headers, {
      name: '  João Souza  ', cpf: '529.982.247-25', birthDate: '1990-05-17', phone: '(35) 99999-0000', email: ' JOAO@Exemplo.COM ',
      address: { zip: '37.530-000', street: 'Rua A', number: '10', complement: 'casa', district: 'Centro', city: 'Brazópolis', state: 'mg' },
      guardianName: 'Ana Souza', guardianPhone: '35 3333-4444', anamnesis: { alergias: ['penicilina'], fuma: false }, notes: 'Prefere manhã',
      contactConsent: true,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'João Souza', cpf: CPF, birthDate: '1990-05-17', phone: '35999990000', email: 'joao@exemplo.com',
      address: { zip: '37530000', street: 'Rua A', number: '10', complement: 'casa', district: 'Centro', city: 'Brazópolis', state: 'MG' },
      guardianName: 'Ana Souza', guardianPhone: '3533334444', anamnesis: { alergias: ['penicilina'], fuma: false }, notes: 'Prefere manhã',
      contactConsent: true,
    });
    expect(res.body.consentAt).toBeTruthy();
  });

  it('CPF repetido na mesma clínica: 409; em outra clínica pode; sem CPF pode repetir', async () => {
    const a = await setupUser();
    const b = await setupUser();
    expect((await create(a.headers, { name: 'Um', cpf: CPF })).status).toBe(201);
    const dup = await create(a.headers, { name: 'Dois', cpf: CPF });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('CPF já cadastrado nesta clínica.');
    expect((await create(b.headers, { name: 'Tres', cpf: CPF })).status).toBe(201);
    expect((await create(a.headers, { name: 'Sem CPF 1' })).status).toBe(201);
    expect((await create(a.headers, { name: 'Sem CPF 2' })).status).toBe(201);
  });

  it('valida os campos (400)', async () => {
    const { headers } = await setupUser();
    const bad = [
      { name: 'x' }, { name: 'Ok', cpf: '111.111.111-11' }, { name: 'Ok', cpf: '12345678900' }, { name: 'Ok', phone: '123' },
      { name: 'Ok', email: 'x' }, { name: 'Ok', birthDate: '17/05/1990' }, { name: 'Ok', address: { state: 'MGG' } },
      { name: 'Ok', address: { zip: '123' } }, { name: 'Ok', anamnesis: ['lista'] }, { name: 'Ok', anamnesis: 'texto' },
      { name: 'Ok', contactConsent: 'sim' }, { name: 'Ok', notes: 'x'.repeat(5001) }, {},
    ];
    for (const body of bad) expect((await create(headers, body)).status, JSON.stringify(body)).toBe(400);
  });

  it('secretária e dentista também cadastram; sem login é 401', async () => {
    const { clinic } = await setupUser();
    for (const role of ['secretary', 'dentist']) {
      const { headers } = await setupUser({ role, clinic });
      expect((await create(headers, { name: `Paciente de ${role}` })).status).toBe(201);
    }
    expect((await api().post('/api/patients').send({ name: 'Sem login' })).status).toBe(401);
  });

  it('erros inesperados do banco continuam subindo (ex.: nome grande demais)', async () => {
    const { clinic, user } = await setupUser();
    const auth = { clinicId: clinic.id, userId: user.id };
    await expect(createPatientService(auth, { name: 'x'.repeat(300) })).rejects.toThrow();
    const p = await createPatient(clinic);
    await expect(updatePatientService(auth, p.id, { name: 'x'.repeat(300) })).rejects.toThrow();
  });
});

describe('GET /api/patients', () => {
  const seed = async () => {
    const { headers, clinic } = await setupUser();
    await createPatient(clinic, { name: 'Ana Lima', cpf: CPF, phone: '35999990001' });
    await createPatient(clinic, { name: 'Bruno Costa', cpf: CPF2, phone: '35988880002', anamnesis: { segredo: 'dado clínico' } });
    await createPatient(clinic, { name: '100% Sorriso', active: false });
    await createPatient(await createClinic(), { name: 'De Outra Clínica' });
    return { headers, clinic };
  };

  it('lista só a própria clínica, em ordem de nome, em formato resumido (sem anamnese nem endereço)', async () => {
    const { headers } = await seed();
    const res = await api().get('/api/patients').set(headers);
    expect(res.body.data.map((p) => p.name)).toEqual(['100% Sorriso', 'Ana Lima', 'Bruno Costa']);
    expect(res.body).toMatchObject({ page: 1, perPage: 20, total: 3, totalPages: 1 });
    expect(Object.keys(res.body.data[1]).sort()).toEqual(['active', 'birthDate', 'cpf', 'id', 'name', 'phone']);
    expect(JSON.stringify(res.body)).not.toContain('dado clínico');
  });

  it('filtra por situação e busca por nome, CPF (com ou sem máscara) e telefone; % é texto', async () => {
    const { headers } = await seed();
    const names = async (qs) => (await api().get(`/api/patients?${qs}`).set(headers)).body.data.map((p) => p.name);
    expect(await names('active=false')).toEqual(['100% Sorriso']);
    expect(await names('active=true')).toEqual(['Ana Lima', 'Bruno Costa']);
    expect(await names('q=bruno')).toEqual(['Bruno Costa']);
    expect(await names(`q=${encodeURIComponent('529.982')}`)).toEqual(['Ana Lima']);
    expect(await names('q=11144')).toEqual(['Bruno Costa']);
    expect(await names('q=88880002')).toEqual(['Bruno Costa']);
    expect(await names('q=%25')).toEqual(['100% Sorriso']);
    expect(await names('q=zzz')).toEqual([]);
    const page = await api().get('/api/patients?perPage=2&page=2').set(headers);
    expect(page.body).toMatchObject({ page: 2, perPage: 2, total: 3, totalPages: 2 });
    expect(page.body.data).toHaveLength(1);
    expect((await api().get('/api/patients?perPage=101').set(headers)).status).toBe(400);
  });

  it('listar não gera auditoria de leitura', async () => {
    const { headers, clinic } = await seed();
    await api().get('/api/patients').set(headers);
    expect(await db('audit_log').where({ clinic_id: clinic.id })).toHaveLength(0);
  });
});

describe('GET /api/patients/:id (ficha)', () => {
  it('devolve a ficha completa e registra a leitura na auditoria, a cada consulta', async () => {
    const { headers, clinic, user } = await setupUser();
    const patient = await createPatient(clinic, { name: 'Ana Lima', anamnesis: { alergias: ['dipirona'] } });
    const res = await api().get(`/api/patients/${patient.id}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: patient.id, name: 'Ana Lima', anamnesis: { alergias: ['dipirona'] } });

    await api().get(`/api/patients/${patient.id}`).set(headers);
    const rows = await audit(clinic.id, patient.id);
    expect(rows.map((r) => r.action)).toEqual(['read', 'read']);
    expect(rows[0]).toMatchObject({ user_id: user.id, entity: 'patient' });
  });

  it('404 (sem auditoria) para paciente de outra clínica ou inexistente; 400 para id inválido', async () => {
    const a = await setupUser();
    const other = await createPatient(await createClinic());
    expect((await api().get(`/api/patients/${other.id}`).set(a.headers)).status).toBe(404);
    expect((await api().get('/api/patients/00000000-0000-4000-8000-000000000000').set(a.headers)).status).toBe(404);
    expect((await api().get('/api/patients/abc').set(a.headers)).status).toBe(400);
    expect(await db('audit_log')).toHaveLength(0);
  });
});

describe('PATCH /api/patients/:id', () => {
  it('altera campos, mantém os demais e audita só os NOMES dos campos alterados', async () => {
    const { headers, clinic } = await setupUser();
    const p = (await create(headers, { name: 'Ana Lima', phone: '35999990001', notes: 'obs' })).body;
    const res = await patch(headers, p.id, { name: 'Ana Souza Lima', email: 'ana@x.com', anamnesis: { pressao: 'alta' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Ana Souza Lima', email: 'ana@x.com', phone: '35999990001', notes: 'obs', anamnesis: { pressao: 'alta' } });

    const rows = await audit(clinic.id, p.id);
    expect(rows.at(-1)).toMatchObject({ action: 'update', changes: { fields: ['name', 'email', 'anamnesis'] } });
    expect(JSON.stringify(rows.at(-1).changes)).not.toContain('alta');
  });

  it('endereço: só as partes enviadas mudam; null limpa; CPF e outros campos também podem ser limpos', async () => {
    const { headers } = await setupUser();
    const p = (await create(headers, { name: 'Ana Lima', cpf: CPF, address: { city: 'Brazópolis', state: 'MG', street: 'Rua A' } })).body;
    const res = await patch(headers, p.id, { address: { street: 'Rua B', state: null }, cpf: null, birthDate: '2000-01-01' });
    expect(res.body.address).toMatchObject({ city: 'Brazópolis', street: 'Rua B', state: null });
    expect(res.body).toMatchObject({ cpf: null, birthDate: '2000-01-01' });
  });

  it('aceite de contato: ligar registra a data, repetir mantém a data, revogar zera', async () => {
    const { headers, clinic } = await setupUser();
    const p = (await create(headers, { name: 'Ana Lima' })).body;
    const on = await patch(headers, p.id, { contactConsent: true });
    expect(on.body.contactConsent).toBe(true);
    const firstDate = on.body.consentAt;
    expect(firstDate).toBeTruthy();

    expect((await patch(headers, p.id, { contactConsent: true })).body.consentAt).toBe(firstDate);
    const off = await patch(headers, p.id, { contactConsent: false });
    expect(off.body).toMatchObject({ contactConsent: false, consentAt: null });
    expect((await audit(clinic.id, p.id)).at(-1).changes.fields).toEqual(['contactConsent']);
  });

  it('arquiva e reativa o paciente (não existe exclusão)', async () => {
    const { headers } = await setupUser();
    const p = (await create(headers, { name: 'Ana Lima' })).body;
    expect((await patch(headers, p.id, { active: false })).body.active).toBe(false);
    expect((await patch(headers, p.id, { active: true })).body.active).toBe(true);
    expect((await api().delete(`/api/patients/${p.id}`).set(headers)).status).toBe(404);
  });

  it('CPF de outro paciente: 409', async () => {
    const { headers } = await setupUser();
    await create(headers, { name: 'Um', cpf: CPF });
    const two = (await create(headers, { name: 'Dois' })).body;
    expect((await patch(headers, two.id, { cpf: CPF })).status).toBe(409);
  });

  it('404 (sem alterar nada) para paciente de outra clínica ou inexistente', async () => {
    const { headers } = await setupUser();
    const other = await createPatient(await createClinic(), { name: 'Original' });
    expect((await patch(headers, other.id, { name: 'Invasor' })).status).toBe(404);
    expect((await db('patients').where({ id: other.id }).first()).name).toBe('Original');
    expect((await patch(headers, '00000000-0000-4000-8000-000000000000', { name: 'Fulano' })).status).toBe(404);
  });

  it('valida o corpo (400)', async () => {
    const { headers, clinic } = await setupUser();
    const p = await createPatient(clinic);
    for (const bad of [{}, { cpf: '123' }, { phone: 'abc' }, { active: 'sim' }, { anamnesis: [] }, { address: { zip: '1' } }]) {
      expect((await patch(headers, p.id, bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe('auditoria (append-only e isolada)', () => {
  it('a aplicação não consegue alterar nem apagar registros de auditoria', async () => {
    const { headers, clinic } = await setupUser();
    const p = (await create(headers, { name: 'Ana Lima' })).body;
    await expect(withTenant(clinic.id, (trx) => trx('audit_log').where({ entity_id: p.id }).update({ action: 'x' }))).rejects.toThrow(/permission denied/);
    await expect(withTenant(clinic.id, (trx) => trx('audit_log').where({ entity_id: p.id }).del())).rejects.toThrow(/permission denied/);
    expect(await audit(clinic.id, p.id)).toHaveLength(1);
  });

  it('cada clínica só enxerga a própria auditoria', async () => {
    const a = await setupUser();
    const b = await setupUser();
    await create(a.headers, { name: 'Ana Lima' });
    expect(await withTenant(b.clinic.id, (trx) => trx('audit_log'))).toHaveLength(0);
    expect(await withTenant(a.clinic.id, (trx) => trx('audit_log'))).toHaveLength(1);
  });
});
