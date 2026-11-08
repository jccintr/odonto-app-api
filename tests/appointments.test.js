import { describe, expect, it, vi } from 'vitest';
import db from '../src/db/knex.js';
import { api, bearer, createClinic, createDentist, createPatient, createProcedure, loginAs, setupUser } from './helpers/factories.js';

const T = (h, m = 0) => `2099-11-03T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
const book = (headers, body) => api().post('/api/appointments').set(headers).send(body);
const slot = (c, h1, h2, extra = {}) => ({ patientId: c.patient.id, dentistId: c.dentist.dentist.id, startsAt: T(h1), endsAt: T(h2), ...extra });
const patch = (headers, id, body) => api().patch(`/api/appointments/${id}`).set(headers).send(body);
const dentistHeaders = async (user) => bearer((await loginAs(user)).accessToken);

async function setup() {
  const admin = await setupUser();
  const dentist = await createDentist(admin.clinic, { name: 'Dr. Paulo' });
  const patient = await createPatient(admin.clinic, { name: 'Ana Lima', phone: '35999990001' });
  const patient2 = await createPatient(admin.clinic, { name: 'Carlos Souza', phone: '35999990002' });
  const procedure = await createProcedure(admin.clinic, { name: 'Restauração' });
  return { ...admin, dentist, patient, patient2, procedure };
}

describe('POST /api/appointments', () => {
  it('agenda um atendimento e devolve paciente e dentista resumidos', async () => {
    const c = await setup();
    const res = await book(c.headers, slot(c, 9, 10, { notes: 'Revisão' }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      patient: { id: c.patient.id, name: 'Ana Lima', phone: '35999990001' },
      dentist: { id: c.dentist.dentist.id, name: 'Dr. Paulo', color: '#0f766e' },
      startsAt: T(9), endsAt: T(10), status: 'scheduled', notes: 'Revisão', canceledReason: null,
    });
    expect((await db('appointments').where({ id: res.body.id }).first()).created_by).toBe(c.user.id);
  });

  it('a secretária também agenda', async () => {
    const c = await setup();
    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });
    expect((await book(secretary.headers, slot(c, 9, 10))).status).toBe(201);
  });

  it('o dentista agenda só na própria agenda (o dentistId é opcional para ele)', async () => {
    const c = await setup();
    const other = await createDentist(c.clinic);
    const headers = await dentistHeaders(c.dentist.user);

    const implicit = await book(headers, { patientId: c.patient.id, startsAt: T(9), endsAt: T(10) });
    expect(implicit.status).toBe(201);
    expect(implicit.body.dentist.id).toBe(c.dentist.dentist.id);
    expect((await book(headers, slot(c, 11, 12))).status).toBe(201); // informando o próprio id
    const foreign = await book(headers, { ...slot(c, 13, 14), dentistId: other.dentist.id });
    expect(foreign.status).toBe(403);
  });

  it('administrador e secretária precisam informar o dentista (400)', async () => {
    const c = await setup();
    const res = await book(c.headers, { patientId: c.patient.id, startsAt: T(9), endsAt: T(10) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Informe o dentista.');
  });

  it('paciente ou dentista de outra clínica, inexistentes ou inválidos: 404; arquivado ou desativado: 422', async () => {
    const c = await setup();
    const foreignPatient = await createPatient(await createClinic());
    const foreignDentist = await createDentist(await createClinic());
    const demoted = await createDentist(c.clinic);
    await db('users').where({ id: demoted.user.id }).update({ role: 'secretary' });
    const missing = '00000000-0000-4000-8000-000000000000';

    expect((await book(c.headers, slot(c, 9, 10, { patientId: foreignPatient.id }))).status).toBe(404);
    expect((await book(c.headers, slot(c, 9, 10, { patientId: missing }))).status).toBe(404);
    expect((await book(c.headers, slot(c, 9, 10, { dentistId: foreignDentist.dentist.id }))).status).toBe(404);
    expect((await book(c.headers, slot(c, 9, 10, { dentistId: missing }))).status).toBe(404);
    expect((await book(c.headers, slot(c, 9, 10, { dentistId: demoted.dentist.id }))).status).toBe(404);

    await db('patients').where({ id: c.patient.id }).update({ active: false });
    expect((await book(c.headers, slot(c, 9, 10))).status).toBe(422);
    await db('patients').where({ id: c.patient.id }).update({ active: true });
    await db('users').where({ id: c.dentist.user.id }).update({ active: false });
    expect((await book(c.headers, slot(c, 9, 10))).status).toBe(422);
    expect(await db('appointments')).toHaveLength(0);
  });

  it('valida o corpo (400): término antes ou igual ao início, datas e ids inválidos', async () => {
    const c = await setup();
    const bad = [
      slot(c, 10, 9), slot(c, 9, 9), { ...slot(c, 9, 10), startsAt: '03/11/2026 09:00' }, { ...slot(c, 9, 10), startsAt: '2099-11-03T09:00:00' },
      { ...slot(c, 9, 10), patientId: 'abc' }, { ...slot(c, 9, 10), patientId: undefined }, slot(c, 9, 10, { notes: 'x'.repeat(2001) }),
    ];
    for (const body of bad) expect((await book(c.headers, body)).status, JSON.stringify(body)).toBe(400);
    expect((await book(c.headers, { ...slot(c, 9, 10), startsAt: '2099-11-03T06:00:00-03:00' })).status).toBe(201); // fuso é aceito
  });

  it('horário sobreposto do mesmo dentista: 409 SLOT_TAKEN; encostar (fim = início) pode', async () => {
    const c = await setup();
    await book(c.headers, slot(c, 9, 10));
    for (const [a, b] of [[9, 10], [9, 11], [8, 10], [8, 11]]) {
      const res = await book(c.headers, slot(c, a, b));
      expect(res.status, `${a}-${b}`).toBe(409);
      expect(res.body.code).toBe('SLOT_TAKEN');
    }
    expect((await book(c.headers, slot(c, 10, 11))).status).toBe(201);
    expect((await book(c.headers, slot(c, 8, 9))).status).toBe(201);
  });

  it('outro dentista no mesmo horário pode (com outro paciente); cancelar libera o horário', async () => {
    const c = await setup();
    const other = await createDentist(c.clinic);
    const otherPatient = await createPatient(c.clinic, { name: 'Bia Costa' });
    const first = (await book(c.headers, slot(c, 9, 10))).body;
    expect((await book(c.headers, slot(c, 9, 10, { dentistId: other.dentist.id, patientId: otherPatient.id }))).status).toBe(201);
    expect((await book(c.headers, slot(c, 9, 10))).status).toBe(409);

    await api().post(`/api/appointments/${first.id}/status`).set(c.headers).send({ status: 'canceled' });
    expect((await book(c.headers, slot(c, 9, 10))).status).toBe(201);
  });

  it('o mesmo paciente não pode estar em dois lugares: 409 PATIENT_BUSY com outro dentista; encostar e cancelado pode', async () => {
    const c = await setup();
    const other = await createDentist(c.clinic);
    const first = (await book(c.headers, slot(c, 9, 10))).body;
    for (const [a, b] of [[9, 10], [9, 11], [8, 10], [8, 11]]) {
      const res = await book(c.headers, slot(c, a, b, { dentistId: other.dentist.id }));
      expect(res.status, `${a}-${b}`).toBe(409);
      expect(res.body.code).toBe('PATIENT_BUSY');
    }
    expect((await book(c.headers, slot(c, 10, 11, { dentistId: other.dentist.id }))).status).toBe(201); // encosta
    expect((await book(c.headers, slot(c, 8, 9, { dentistId: other.dentist.id }))).status).toBe(201);

    await api().post(`/api/appointments/${first.id}/status`).set(c.headers).send({ status: 'canceled' });
    expect((await book(c.headers, slot(c, 9, 10, { dentistId: other.dentist.id }))).status).toBe(201); // cancelado libera
  });

  it('o dentista também não consegue marcar o paciente que já está em outro atendimento', async () => {
    const c = await setup();
    const other = await createDentist(c.clinic);
    await book(c.headers, slot(c, 9, 10));
    const res = await book(await dentistHeaders(other.user), { patientId: c.patient.id, startsAt: T(9, 30), endsAt: T(10, 30) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PATIENT_BUSY');
  });

  it('remarcar para um horário em que o paciente já está em outro atendimento: 409 PATIENT_BUSY (e nada muda)', async () => {
    const c = await setup();
    const other = await createDentist(c.clinic);
    await book(c.headers, slot(c, 10, 11));
    const a = (await book(c.headers, slot(c, 8, 9, { dentistId: other.dentist.id }))).body;
    const res = await patch(c.headers, a.id, { startsAt: T(10, 30) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PATIENT_BUSY');
    expect((await api().get(`/api/appointments/${a.id}`).set(c.headers)).body.startsAt).toBe(T(8));
    // trocar o dentista para um horário livre do paciente continua valendo
    expect((await patch(c.headers, a.id, { dentistId: c.dentist.dentist.id })).status).toBe(200);
  });

  it('o banco recusa (FK composta) atendimento ligando paciente ou dentista de outra clínica', async () => {
    const c = await setup();
    const foreignPatient = await createPatient(await createClinic());
    const foreignDentist = await createDentist(await createClinic());
    const base = { clinic_id: c.clinic.id, starts_at: T(9), ends_at: T(10) };
    await expect(db('appointments').insert({ ...base, patient_id: foreignPatient.id, dentist_id: c.dentist.dentist.id })).rejects.toThrow(/foreign key/);
    await expect(db('appointments').insert({ ...base, patient_id: c.patient.id, dentist_id: foreignDentist.dentist.id })).rejects.toThrow(/foreign key/);
  });

  it('exige login (401)', async () => {
    expect((await api().post('/api/appointments').send({})).status).toBe(401);
  });
});

describe('GET /api/appointments', () => {
  async function seed() {
    const c = await setup();
    const d2 = await createDentist(c.clinic, { name: 'Dra. Bia' });
    const p2 = await createPatient(c.clinic, { name: 'Bruno Costa' });
    const a = (await book(c.headers, slot(c, 9, 10))).body;
    const b = (await book(c.headers, slot(c, 11, 12, { patientId: p2.id }))).body;
    const d = (await book(c.headers, slot(c, 9, 10, { dentistId: d2.dentist.id, patientId: c.patient2.id }))).body;
    await api().post(`/api/appointments/${b.id}/status`).set(c.headers).send({ status: 'canceled' });
    const foreign = await setup();
    await book(foreign.headers, slot(foreign, 9, 10));
    return { ...c, d2, p2, a, b, d };
  }
  const ids = async (headers, qs = '') => (await api().get(`/api/appointments?${qs}`).set(headers)).body.data.map((x) => x.id);

  it('lista só a própria clínica, em ordem de horário', async () => {
    const c = await seed();
    const res = await api().get('/api/appointments').set(c.headers);
    expect(res.body).toMatchObject({ page: 1, perPage: 100, total: 3, totalPages: 1 });
    expect(res.body.data.map((x) => x.startsAt)).toEqual([T(9), T(9), T(11)]);
    expect(res.body.data.map((x) => x.id)).toEqual(expect.arrayContaining([c.a.id, c.b.id, c.d.id]));
  });

  it('filtra por dentista, paciente e situação', async () => {
    const c = await seed();
    expect(await ids(c.headers, `dentistId=${c.d2.dentist.id}`)).toEqual([c.d.id]);
    expect(await ids(c.headers, `patientId=${c.p2.id}`)).toEqual([c.b.id]);
    expect(await ids(c.headers, 'status=canceled')).toEqual([c.b.id]);
    expect(await ids(c.headers, 'status=attended')).toEqual([]);
  });

  it('filtra por intervalo: entra quem encosta no período [from, to)', async () => {
    const c = await seed();
    const days = async (qs) => (await ids(c.headers, qs)).length;
    expect(await days(`from=${T(10)}`)).toBe(1); // os das 9-10 terminam às 10:00 e ficam fora
    expect(await days(`from=${T(9, 30)}`)).toBe(3);
    expect(await days(`to=${T(9)}`)).toBe(0); // começam às 9:00, não antes
    expect(await days(`to=${T(9, 1)}`)).toBe(2);
    expect(await days(`from=${T(9)}&to=${T(10)}`)).toBe(2);
  });

  it('pagina', async () => {
    const c = await seed();
    const res = await api().get('/api/appointments?perPage=2&page=2').set(c.headers);
    expect(res.body).toMatchObject({ page: 2, perPage: 2, total: 3, totalPages: 2 });
    expect(res.body.data).toHaveLength(1);
  });

  it('o dentista vê só a própria agenda, mesmo pedindo o filtro de outro', async () => {
    const c = await seed();
    const own = await dentistHeaders(c.dentist.user);
    expect(await ids(own)).toEqual(expect.arrayContaining([c.a.id, c.b.id]));
    expect((await ids(own)).length).toBe(2);
    expect(await ids(own, `dentistId=${c.d2.dentist.id}`)).toHaveLength(2);
  });

  it('valida a consulta (400) e exige login (401)', async () => {
    const c = await seed();
    for (const qs of ['from=ontem', 'to=2099-11-03', 'perPage=201', 'status=x', 'dentistId=abc', 'patientId=abc', 'page=0']) {
      expect((await api().get(`/api/appointments?${qs}`).set(c.headers)).status, qs).toBe(400);
    }
    expect((await api().get('/api/appointments')).status).toBe(401);
  });
});

describe('GET /api/appointments/:id', () => {
  it('devolve o atendimento; 404 para outra clínica, inexistente ou de outro dentista (visão do dentista); 400 para id inválido', async () => {
    const c = await setup();
    const other = await createDentist(c.clinic);
    const mine = (await book(c.headers, slot(c, 9, 10))).body;
    const theirs = (await book(c.headers, slot(c, 9, 10, { dentistId: other.dentist.id, patientId: c.patient2.id }))).body;
    const foreign = await setup();
    const foreignAppt = (await book(foreign.headers, slot(foreign, 9, 10))).body;
    const get = (headers, id) => api().get(`/api/appointments/${id}`).set(headers);

    expect((await get(c.headers, mine.id)).body.id).toBe(mine.id);
    expect((await get(c.headers, foreignAppt.id)).status).toBe(404);
    expect((await get(c.headers, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await get(c.headers, 'abc')).status).toBe(400);

    const dentist = await dentistHeaders(c.dentist.user);
    expect((await get(dentist, mine.id)).status).toBe(200);
    expect((await get(dentist, theirs.id)).status).toBe(404);
  });
});

describe('PATCH /api/appointments/:id (remarcar)', () => {
  const status = (headers, id, s, reason, evolution) => api().post(`/api/appointments/${id}/status`).set(headers).send({ status: s, reason, evolution });

  it('só observações: a situação não muda', async () => {
    const c = await setup();
    const a = (await book(c.headers, slot(c, 9, 10))).body;
    await status(c.headers, a.id, 'confirmed');
    const res = await patch(c.headers, a.id, { notes: 'Trazer exames' });
    expect(res.body).toMatchObject({ notes: 'Trazer exames', status: 'confirmed', startsAt: T(9), endsAt: T(10) });
    expect((await patch(c.headers, a.id, { notes: null })).body.notes).toBeNull();
  });

  it('mudar o início mantém a duração; mudar horário ou dentista volta para "agendado"', async () => {
    const c = await setup();
    const a = (await book(c.headers, slot(c, 9, 10, { endsAt: T(10, 30) }))).body;
    await status(c.headers, a.id, 'confirmed');

    const moved = await patch(c.headers, a.id, { startsAt: T(14) });
    expect(moved.body).toMatchObject({ startsAt: T(14), endsAt: T(15, 30), status: 'scheduled' });

    await status(c.headers, a.id, 'confirmed');
    const shorter = await patch(c.headers, a.id, { endsAt: T(14, 45) });
    expect(shorter.body).toMatchObject({ startsAt: T(14), endsAt: T(14, 45), status: 'scheduled' });

    const both = await patch(c.headers, a.id, { startsAt: T(16), endsAt: T(17) });
    expect(both.body).toMatchObject({ startsAt: T(16), endsAt: T(17) });
  });

  it('troca de dentista (inclusive repetir o mesmo) volta para "agendado"', async () => {
    const c = await setup();
    const other = await createDentist(c.clinic, { name: 'Dra. Bia' });
    const a = (await book(c.headers, slot(c, 9, 10))).body;
    await status(c.headers, a.id, 'confirmed');
    const res = await patch(c.headers, a.id, { dentistId: other.dentist.id });
    expect(res.body).toMatchObject({ dentist: { id: other.dentist.id, name: 'Dra. Bia' }, status: 'scheduled' });

    await status(c.headers, a.id, 'confirmed');
    expect((await patch(c.headers, a.id, { dentistId: other.dentist.id })).body.status).toBe('scheduled');
  });

  it('conflito de horário ao remarcar: 409 SLOT_TAKEN (e nada muda)', async () => {
    const c = await setup();
    await book(c.headers, slot(c, 10, 11));
    const a = (await book(c.headers, slot(c, 8, 9))).body;
    const res = await patch(c.headers, a.id, { startsAt: T(10, 30) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SLOT_TAKEN');
    expect((await api().get(`/api/appointments/${a.id}`).set(c.headers)).body.startsAt).toBe(T(8));
  });

  it('término antes do início depois da mescla: 400', async () => {
    const c = await setup();
    const a = (await book(c.headers, slot(c, 9, 10))).body;
    const res = await patch(c.headers, a.id, { endsAt: T(8) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('O término deve ser depois do início.');
  });

  it('atendimento já realizado, faltado ou cancelado não pode ser alterado (409)', async () => {
    const c = await setup();
    for (const [i, final] of [['attended'], ['no_show'], ['canceled']].entries()) {
      const a = (await book(c.headers, slot(c, 9 + i * 2, 10 + i * 2))).body;
      if (final[0] === 'attended') {
        const dh = await dentistHeaders(c.dentist.user);
        await status(dh, a.id, 'in_progress');
        await status(dh, a.id, 'attended', undefined, { procedures: [{ procedureId: c.procedure.id, wholeMouth: true }] });
      } else {
        await status(c.headers, a.id, final[0]);
      }
      expect((await patch(c.headers, a.id, { notes: 'x' })).status).toBe(409);
    }
  });

  it('dentista: altera a própria agenda, não manda para outro dentista (403) e não enxerga atendimento alheio (404)', async () => {
    const c = await setup();
    const other = await createDentist(c.clinic);
    const mine = (await book(c.headers, slot(c, 9, 10))).body;
    const theirs = (await book(c.headers, slot(c, 9, 10, { dentistId: other.dentist.id, patientId: c.patient2.id }))).body;
    const headers = await dentistHeaders(c.dentist.user);

    expect((await patch(headers, mine.id, { notes: 'ok', dentistId: c.dentist.dentist.id })).status).toBe(200);
    expect((await patch(headers, mine.id, { dentistId: other.dentist.id })).status).toBe(403);
    expect((await patch(headers, theirs.id, { notes: 'invasão' })).status).toBe(404);
  });

  it('dentista de destino desativado: 422; inexistente ou de outra clínica: 404', async () => {
    const c = await setup();
    const off = await createDentist(c.clinic, { active: false });
    const foreign = await createDentist(await createClinic());
    const a = (await book(c.headers, slot(c, 9, 10))).body;
    expect((await patch(c.headers, a.id, { dentistId: off.dentist.id })).status).toBe(422);
    expect((await patch(c.headers, a.id, { dentistId: foreign.dentist.id })).status).toBe(404);
  });

  it('404 para atendimento de outra clínica ou inexistente; 400 para corpo inválido', async () => {
    const c = await setup();
    const foreign = await setup();
    const foreignAppt = (await book(foreign.headers, slot(foreign, 9, 10))).body;
    expect((await patch(c.headers, foreignAppt.id, { notes: 'x' })).status).toBe(404);
    expect((await patch(c.headers, '00000000-0000-4000-8000-000000000000', { notes: 'x' })).status).toBe(404);
    const a = (await book(c.headers, slot(c, 9, 10))).body;
    for (const bad of [{}, { startsAt: 'amanhã' }, { dentistId: 'abc' }, { notes: 'x'.repeat(2001) }]) {
      expect((await patch(c.headers, a.id, bad)).status).toBe(400);
    }
  });
});

describe('POST /api/appointments/:id/status', () => {
  const status = (headers, id, body) => api().post(`/api/appointments/${id}/status`).set(headers).send(body);
  // marcar como atendido exige registrar o procedimento e os dentes afetados
  const DONE = (c) => ({ status: 'attended', evolution: { procedures: [{ procedureId: c.procedure.id, teeth: [16] }] } });

  const START = { status: 'in_progress' };

  it('segue o fluxo: agendado -> confirmado -> em atendimento -> atendido', async () => {
    const c = await setup();
    const a = (await book(c.headers, slot(c, 9, 10))).body;
    const dh = await dentistHeaders(c.dentist.user);
    expect((await status(c.headers, a.id, { status: 'confirmed' })).body.status).toBe('confirmed');
    const started = await status(dh, a.id, START);
    expect(started.body).toMatchObject({ status: 'in_progress' });
    expect(started.body.startedAt).toBeTruthy();
    expect((await status(dh, a.id, DONE(c))).body.status).toBe('attended');
  });

  it('o atendimento pode ser iniciado direto do agendado (sem confirmação)', async () => {
    const c = await setup();
    const a = (await book(c.headers, slot(c, 9, 10))).body;
    expect((await status(await dentistHeaders(c.dentist.user), a.id, START)).body.status).toBe('in_progress');
  });

  it('só o dentista inicia o atendimento (403 para administração e secretária) e só se conclui depois de iniciado', async () => {
    const c = await setup();
    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });
    const a = (await book(c.headers, slot(c, 9, 10))).body;
    for (const headers of [c.headers, secretary.headers]) expect((await status(headers, a.id, START)).status).toBe(403);
    const dh = await dentistHeaders(c.dentist.user);
    const early = await status(dh, a.id, DONE(c)); // sem iniciar não conclui
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('INVALID_TRANSITION');
    await status(dh, a.id, START);
    expect((await status(dh, a.id, { status: 'canceled' })).status).toBe(409); // iniciado, só se conclui
    expect((await status(dh, a.id, { status: 'no_show' })).status).toBe(409);
    expect((await status(dh, a.id, START)).status).toBe(409);
    expect((await patch(c.headers, a.id, { notes: 'x' })).status).toBe(409); // não se remarca o que já começou
  });

  it('cancelar guarda o motivo (opcional); outras situações não têm motivo', async () => {
    const c = await setup();
    const a = (await book(c.headers, slot(c, 9, 10))).body;
    const b = (await book(c.headers, slot(c, 11, 12))).body;
    const d = (await book(c.headers, slot(c, 13, 14))).body;
    expect((await status(c.headers, a.id, { status: 'canceled', reason: 'Paciente avisou' })).body).toMatchObject({ status: 'canceled', canceledReason: 'Paciente avisou' });
    expect((await status(c.headers, b.id, { status: 'canceled' })).body.canceledReason).toBeNull();
    expect((await status(c.headers, d.id, { status: 'no_show', reason: 'ignorado' })).body).toMatchObject({ status: 'no_show', canceledReason: null });
  });

  it('transições inválidas: 409 INVALID_TRANSITION', async () => {
    const c = await setup();
    const a = (await book(c.headers, slot(c, 9, 10))).body;
    const same = await status(c.headers, a.id, { status: 'scheduled' });
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('INVALID_TRANSITION');

    await status(c.headers, a.id, { status: 'confirmed' });
    expect((await status(c.headers, a.id, { status: 'confirmed' })).status).toBe(409);
    expect((await status(c.headers, a.id, { status: 'scheduled' })).status).toBe(409);
    const dh = await dentistHeaders(c.dentist.user);
    await status(dh, a.id, START);
    await status(dh, a.id, DONE(c));
    for (const s of ['confirmed', 'canceled', 'no_show', 'scheduled']) expect((await status(c.headers, a.id, { status: s })).status).toBe(409);
    expect((await status(dh, a.id, START)).status).toBe(409);
  });

  it('dentista muda a situação só dos próprios atendimentos (404 nos alheios)', async () => {
    const c = await setup();
    const other = await createDentist(c.clinic);
    const mine = (await book(c.headers, slot(c, 9, 10))).body;
    const theirs = (await book(c.headers, slot(c, 9, 10, { dentistId: other.dentist.id, patientId: c.patient2.id }))).body;
    const headers = await dentistHeaders(c.dentist.user);
    expect((await status(headers, mine.id, START)).status).toBe(200);
    expect((await status(headers, mine.id, DONE(c))).status).toBe(200);
    expect((await status(headers, theirs.id, START)).status).toBe(404);
    expect((await status(headers, theirs.id, DONE(c))).status).toBe(404);
  });

  it('valida o corpo (400) e isola as clínicas (404)', async () => {
    const c = await setup();
    const foreign = await setup();
    const foreignAppt = (await book(foreign.headers, slot(foreign, 9, 10))).body;
    const a = (await book(c.headers, slot(c, 9, 10))).body;
    for (const bad of [{}, { status: 'x' }, { status: 'canceled', reason: 'x'.repeat(241) }]) {
      expect((await status(c.headers, a.id, bad)).status).toBe(400);
    }
    expect((await status(c.headers, foreignAppt.id, { status: 'confirmed' })).status).toBe(404);
    expect((await status(c.headers, 'abc', { status: 'confirmed' })).status).toBe(400);
  });
});

describe('datas passadas', () => {
  const at = (ms) => new Date(Date.now() + ms).toISOString();
  const MIN = 60_000;

  it('não agenda em data e hora que já passaram (400 PAST_DATE), mas tolera um encaixe de poucos minutos atrás', async () => {
    const c = await setup();
    const past = await book(c.headers, { ...slot(c, 9, 10), startsAt: at(-2 * 24 * 60 * MIN), endsAt: at(-2 * 24 * 60 * MIN + 60 * MIN) });
    expect(past.status).toBe(400);
    expect(past.body.code).toBe('PAST_DATE');
    const justPast = await book(c.headers, { ...slot(c, 9, 10), startsAt: at(-10 * MIN), endsAt: at(50 * MIN) });
    expect(justPast.status).toBe(400);
    expect(await db('appointments')).toHaveLength(0);

    const walkIn = await book(c.headers, { ...slot(c, 9, 10), startsAt: at(-2 * MIN), endsAt: at(58 * MIN) });
    expect(walkIn.status).toBe(201);
  });

  it('vale para a secretária e o dentista também', async () => {
    const c = await setup();
    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });
    const body = { ...slot(c, 9, 10), startsAt: at(-3 * 60 * MIN), endsAt: at(-2 * 60 * MIN) };
    expect((await book(secretary.headers, body)).status).toBe(400);
    expect((await book(await dentistHeaders(c.dentist.user), body)).status).toBe(400);
  });

  it('remarcar para o passado: 400; editar só observações de um atendimento antigo continua valendo', async () => {
    const c = await setup();
    const row = await db('appointments').insert({
      clinic_id: c.clinic.id, patient_id: c.patient.id, dentist_id: c.dentist.dentist.id, starts_at: at(-3 * 24 * 60 * MIN), ends_at: at(-3 * 24 * 60 * MIN + 60 * MIN),
    }).returning('*');
    const id = row[0].id;
    expect((await api().patch(`/api/appointments/${id}`).set(c.headers).send({ notes: 'Paciente chegou atrasado' })).status).toBe(200);
    const moved = await api().patch(`/api/appointments/${id}`).set(c.headers).send({ startsAt: at(-24 * 60 * MIN) });
    expect(moved.status).toBe(400);
    expect(moved.body.code).toBe('PAST_DATE');
    // reenviar o mesmo horário (o formulário de remarcação faz isso) não conta como remarcar
    expect((await api().patch(`/api/appointments/${id}`).set(c.headers).send({ startsAt: row[0].starts_at.toISOString() })).status).toBe(200);
    expect((await api().patch(`/api/appointments/${id}`).set(c.headers).send({ startsAt: T(9), endsAt: T(10) })).status).toBe(200);
  });
});
