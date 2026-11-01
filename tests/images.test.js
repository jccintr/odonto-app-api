import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { api, bearer, createDentist, createPatient, loginAs, setupUser } from './helpers/factories.js';
import { fake } from './helpers/fakeStorage.js';

const NOBODY = '0b0d2f7e-8f7b-4d49-9d63-3c2f1f2a1b11';
const base = (patient) => `/api/patients/${patient.id}/images`;

async function setup() {
  const c = await setupUser();
  const patient = await createPatient(c.clinic, { name: 'Ana Lima' });
  const dentist = await createDentist(c.clinic, { name: 'Dr. Paulo' });
  return { ...c, patient, dentist, dentistHeaders: bearer((await loginAs(dentist.user)).accessToken) };
}

/** Passos 1 e 2: assina, "envia" o arquivo (falso) e registra. */
async function upload(c, { body = {}, file = {}, headers = c.headers } = {}) {
  const signed = (await api().post(`${base(c.patient)}/upload-signature`).set(headers).send({})).body;
  fake.upload(signed.publicId, file);
  return api().post(base(c.patient)).set(headers).send({ publicId: signed.publicId, kind: 'xray', ...body });
}

describe('POST /images/upload-signature', () => {
  it('escolhe o identificador do arquivo (clínica/paciente/uuid) e assina o envio', async () => {
    const c = await setup();
    const res = await api().post(`${base(c.patient)}/upload-signature`).set(c.headers).send({});
    expect(res.status).toBe(200);
    expect(res.body.publicId).toMatch(new RegExp(`^odontoapp/${c.clinic.id}/${c.patient.id}/[0-9a-f-]{36}$`));
    expect(res.body).toMatchObject({
      uploadUrl: expect.stringContaining('/image/upload'), allowedFormats: ['jpg', 'jpeg', 'png', 'webp', 'heic'], maxBytes: 10 * 1024 * 1024, validForSeconds: 3600,
      fields: { public_id: res.body.publicId, type: 'private', api_key: 'chave-publica' },
    });
  });

  it('cada pedido gera um identificador novo', async () => {
    const c = await setup();
    const ids = new Set();
    for (let i = 0; i < 3; i += 1) ids.add((await api().post(`${base(c.patient)}/upload-signature`).set(c.headers).send({})).body.publicId);
    expect(ids.size).toBe(3);
  });

  it('paciente inexistente ou de outra clínica: 404; armazenamento sem configuração: 503', async () => {
    const c = await setup();
    const other = await setup();
    expect((await api().post(`/api/patients/${NOBODY}/images/upload-signature`).set(c.headers).send({})).status).toBe(404);
    expect((await api().post(`${base(other.patient)}/upload-signature`).set(c.headers).send({})).status).toBe(404);
    fake.enabled = false;
    const res = await api().post(`${base(c.patient)}/upload-signature`).set(c.headers).send({});
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('STORAGE_NOT_CONFIGURED');
  });
});

describe('POST /images (registrar)', () => {
  it('registra com os dados REAIS do arquivo (formato, tamanho, dimensões), não os do app', async () => {
    const c = await setup();
    const res = await upload(c, { file: { bytes: 345_678, format: 'png', width: 2000, height: 1000 }, body: { kind: 'xray', tooth: 16, takenOn: '2026-10-20', notes: 'Periapical' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      patientId: c.patient.id, kind: 'xray', tooth: 16, takenOn: '2026-10-20', notes: 'Periapical', format: 'png', bytes: 345_678, width: 2000, height: 1000, uploadedBy: c.user.id,
    });
    expect(res.body.url).toContain(res.body.format);
    expect(res.body).not.toHaveProperty('thumbnailUrl'); // sem miniaturas: cada transformação gasta crédito do plano gratuito
    expect(new Date(res.body.urlExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(await db('audit_log').where({ entity: 'patient_image', action: 'create' })).toHaveLength(1);
  });

  it('a data da imagem é hoje (Brasília) quando não informada; sem dimensões, vêm nulas', async () => {
    const c = await setup();
    const res = await upload(c, { file: { width: null, height: null }, body: { kind: 'document' } });
    expect(res.status).toBe(201);
    expect(res.body.takenOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body).toMatchObject({ width: null, height: null, tooth: null, notes: null });
  });

  it('o dentista também envia (a secretária não: ver matriz de segurança)', async () => {
    const c = await setup();
    const res = await upload(c, { headers: c.dentistHeaders });
    expect(res.status).toBe(201);
    expect(res.body.uploadedBy).toBe(c.dentist.user.id);
  });

  it('não registra arquivo de outro paciente, de outra clínica ou com caminho forjado', async () => {
    const c = await setup();
    const other = await setup();
    const otherPatient = await createPatient(c.clinic, { name: 'Outro' });
    const foreign = [
      `odontoapp/${other.clinic.id}/${other.patient.id}/8f14e45f-ceea-467a-9575-8f2d0f6e0b11`, // outra clínica
      `odontoapp/${c.clinic.id}/${otherPatient.id}/8f14e45f-ceea-467a-9575-8f2d0f6e0b11`, // outro paciente da mesma clínica
      `outra-pasta/odontoapp/${c.clinic.id}/${c.patient.id}/8f14e45f-ceea-467a-9575-8f2d0f6e0b11`, // caminho com prefixo extra
      `odontoapp/${c.clinic.id}/${c.patient.id}/../x`,
      `odontoapp/${c.clinic.id}/${c.patient.id}/qualquer-nome`,
      'arquivo-solto',
    ];
    for (const publicId of foreign) {
      fake.upload(publicId);
      const res = await api().post(base(c.patient)).set(c.headers).send({ publicId, kind: 'xray' });
      expect(res.status, publicId).toBe(422);
      expect(res.body.code).toBe('INVALID_PUBLIC_ID');
    }
    expect(await db('patient_images')).toHaveLength(0);
  });

  it('exige que o arquivo tenha sido enviado antes', async () => {
    const c = await setup();
    const signed = (await api().post(`${base(c.patient)}/upload-signature`).set(c.headers).send({})).body;
    const res = await api().post(base(c.patient)).set(c.headers).send({ publicId: signed.publicId, kind: 'xray' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('UPLOAD_NOT_FOUND');
  });

  it('não registra duas vezes o mesmo arquivo', async () => {
    const c = await setup();
    const first = await upload(c);
    const again = await api().post(base(c.patient)).set(c.headers).send({ publicId: (await db('patient_images').first()).public_id, kind: 'photo' });
    expect(first.status).toBe(201);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('IMAGE_ALREADY_REGISTERED');
    expect(await db('patient_images')).toHaveLength(1);
  });

  it('arquivo acima do limite é recusado e apagado do armazenamento', async () => {
    const c = await setup();
    const res = await upload(c, { file: { bytes: 10 * 1024 * 1024 + 1 } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
    expect(fake.destroyed).toHaveLength(1);
    expect(await db('patient_images')).toHaveLength(0);
    expect((await upload(c, { file: { bytes: 10 * 1024 * 1024 } })).status).toBe(201); // exatamente no limite passa
  });

  it('falha do armazenamento na conferência dá 502 e não registra', async () => {
    const c = await setup();
    const signed = (await api().post(`${base(c.patient)}/upload-signature`).set(c.headers).send({})).body;
    fake.upload(signed.publicId);
    fake.failFetch = true;
    const res = await api().post(base(c.patient)).set(c.headers).send({ publicId: signed.publicId, kind: 'xray' });
    expect(res.status).toBe(502);
    expect(await db('patient_images')).toHaveLength(0);
  });

  it('valida os dados e o paciente', async () => {
    const c = await setup();
    const bad = (body, url = base(c.patient)) => api().post(url).set(c.headers).send(body);
    for (const body of [{}, { publicId: 'x' }, { kind: 'xray' }, { publicId: 'x', kind: 'selfie' }, { publicId: 'x', kind: 'xray', tooth: 99 },
      { publicId: 'x', kind: 'xray', takenOn: '10/10/2026' }, { publicId: 'x'.repeat(301), kind: 'xray' }, { publicId: 'x', kind: 'xray', notes: 'x'.repeat(501) }]) {
      expect((await bad(body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect((await bad({ publicId: 'x', kind: 'xray' }, `/api/patients/${NOBODY}/images`)).status).toBe(404);
  });
});

describe('GET /images', () => {
  async function seed() {
    const c = await setup();
    await upload(c, { body: { kind: 'xray', tooth: 16, takenOn: '2026-01-10' } });
    await upload(c, { body: { kind: 'photo', takenOn: '2026-03-05' } });
    await upload(c, { body: { kind: 'xray', tooth: 26, takenOn: '2026-02-01' } });
    return c;
  }

  it('lista da imagem mais recente para a mais antiga, com links e paginação', async () => {
    const c = await seed();
    const res = await api().get(base(c.patient)).set(c.headers);
    expect(res.status).toBe(200);
    expect(res.body.data.map((i) => i.takenOn)).toEqual(['2026-03-05', '2026-02-01', '2026-01-10']);
    expect(res.body).toMatchObject({ total: 3, page: 1, perPage: 20, totalPages: 1 });
    for (const image of res.body.data) expect(image.url).toMatch(/^https:\/\/download\.fake\.test\//);

    const second = await api().get(`${base(c.patient)}?perPage=2&page=2`).set(c.headers);
    expect(second.body.data.map((i) => i.takenOn)).toEqual(['2026-01-10']);
  });

  it('filtra por tipo e por dente; a secretária e o dentista também consultam', async () => {
    const c = await seed();
    expect((await api().get(`${base(c.patient)}?kind=xray`).set(c.headers)).body.total).toBe(2);
    expect((await api().get(`${base(c.patient)}?tooth=26`).set(c.headers)).body.data.map((i) => i.tooth)).toEqual([26]);
    expect((await api().get(`${base(c.patient)}?kind=xray&tooth=16`).set(c.headers)).body.total).toBe(1);
    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });
    expect((await api().get(base(c.patient)).set(secretary.headers)).body.total).toBe(3);
    expect((await api().get(base(c.patient)).set(c.dentistHeaders)).body.total).toBe(3);
  });

  it('só mostra imagens do paciente consultado e nunca as removidas', async () => {
    const c = await seed();
    const other = await createPatient(c.clinic, { name: 'Outro paciente' });
    expect((await api().get(base(other)).set(c.headers)).body.total).toBe(0);
    const first = (await api().get(base(c.patient)).set(c.headers)).body.data[0];
    await api().delete(`${base(c.patient)}/${first.id}`).set(c.headers);
    expect((await api().get(base(c.patient)).set(c.headers)).body.total).toBe(2);
  });

  it('cada consulta à lista é auditada; filtros inválidos dão 400; paciente inexistente dá 404', async () => {
    const c = await seed();
    await api().get(base(c.patient)).set(c.headers);
    expect(await db('audit_log').where({ entity: 'patient', action: 'read_images', entity_id: c.patient.id })).toHaveLength(1);
    for (const query of ['?kind=selfie', '?tooth=99', '?tooth=abc', '?page=0']) {
      expect((await api().get(`${base(c.patient)}${query}`).set(c.headers)).status, query).toBe(400);
    }
    expect((await api().get(`/api/patients/${NOBODY}/images`).set(c.headers)).status).toBe(404);
  });

  it('sem armazenamento configurado, as imagens não podem ser entregues (503)', async () => {
    const c = await seed();
    fake.enabled = false;
    expect((await api().get(base(c.patient)).set(c.headers)).status).toBe(503);
  });
});

describe('GET, PATCH e DELETE /images/:imageId', () => {
  it('consulta uma imagem com links novos (auditado) e não acha de outro paciente nem inexistente', async () => {
    const c = await setup();
    const image = (await upload(c)).body;
    const res = await api().get(`${base(c.patient)}/${image.id}`).set(c.headers);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(image.id);
    expect(await db('audit_log').where({ entity: 'patient_image', action: 'read', entity_id: image.id })).toHaveLength(1);

    const other = await createPatient(c.clinic, { name: 'Outro' });
    expect((await api().get(`${base(other)}/${image.id}`).set(c.headers)).status).toBe(404);
    expect((await api().get(`${base(c.patient)}/${NOBODY}`).set(c.headers)).status).toBe(404);
  });

  it('altera tipo, dente, data e observações (e limpa dente e observações com null)', async () => {
    const c = await setup();
    const image = (await upload(c, { body: { tooth: 16, notes: 'inicial' } })).body;
    const res = await api().patch(`${base(c.patient)}/${image.id}`).set(c.headers).send({ kind: 'photo', takenOn: '2026-05-05', tooth: 21, notes: 'nova' });
    expect(res.body).toMatchObject({ kind: 'photo', takenOn: '2026-05-05', tooth: 21, notes: 'nova', format: image.format, bytes: image.bytes });
    const cleared = await api().patch(`${base(c.patient)}/${image.id}`).set(c.headers).send({ tooth: null, notes: null });
    expect(cleared.body).toMatchObject({ tooth: null, notes: null });
    const log = await db('audit_log').where({ entity: 'patient_image', action: 'update' }).orderBy('created_at');
    expect(log.map((l) => l.changes.fields)).toEqual([['kind', 'tooth', 'takenOn', 'notes'], ['tooth', 'notes']]);
  });

  it('alteração inválida ou de imagem inexistente não funciona', async () => {
    const c = await setup();
    const image = (await upload(c)).body;
    for (const body of [{}, { kind: 'selfie' }, { tooth: 99 }, { takenOn: 'ontem' }, { publicId: 'outro' }]) {
      const res = await api().patch(`${base(c.patient)}/${image.id}`).set(c.headers).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await api().patch(`${base(c.patient)}/${NOBODY}`).set(c.headers).send({ notes: 'x' })).status).toBe(404);
  });

  it('remove: apaga o arquivo no armazenamento e guarda o registro como removido', async () => {
    const c = await setup();
    const image = (await upload(c)).body;
    const publicId = (await db('patient_images').first()).public_id;
    expect((await api().delete(`${base(c.patient)}/${image.id}`).set(c.headers)).status).toBe(204);

    expect(fake.destroyed).toEqual([publicId]);
    expect(await db('patient_images').first()).toMatchObject({ removed_by: c.user.id });
    expect((await db('patient_images').first()).removed_at).toBeTruthy();
    expect((await api().get(`${base(c.patient)}/${image.id}`).set(c.headers)).status).toBe(404);
    expect((await api().delete(`${base(c.patient)}/${image.id}`).set(c.headers)).status).toBe(404);
    expect(await db('audit_log').where({ entity: 'patient_image', action: 'remove' })).toHaveLength(1);
  });

  it('se o armazenamento falhar ao apagar, a imagem continua na ficha (nada pela metade)', async () => {
    const c = await setup();
    const image = (await upload(c)).body;
    fake.failDestroy = true;
    const res = await api().delete(`${base(c.patient)}/${image.id}`).set(c.headers);
    expect(res.status).toBe(502);
    expect((await db('patient_images').first()).removed_at).toBeNull();
    fake.failDestroy = false;
    expect((await api().delete(`${base(c.patient)}/${image.id}`).set(c.headers)).status).toBe(204);
  });

  it('o banco recusa tipo, dente e tamanho inválidos, e identificador repetido', async () => {
    const c = await setup();
    const row = { clinic_id: c.clinic.id, patient_id: c.patient.id, kind: 'xray', public_id: 'a', format: 'jpg', bytes: 10, taken_on: '2026-01-01' };
    await expect(db('patient_images').insert({ ...row, kind: 'selfie' })).rejects.toThrow();
    await expect(db('patient_images').insert({ ...row, tooth: 99 })).rejects.toThrow();
    await expect(db('patient_images').insert({ ...row, bytes: 0 })).rejects.toThrow();
    await db('patient_images').insert(row);
    await expect(db('patient_images').insert(row)).rejects.toThrow();
  });
});
