import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { addDays, businessDate } from '../src/utils/dates.js';
import { api, createDentist, createPatient, createProcedure, setupUser } from './helpers/factories.js';
import { headersOf } from './helpers/execute.js';

const start = (n) => ({ startsAt: new Date(Date.UTC(2095, 0, 1) + n * 3_600_000).toISOString(), endsAt: new Date(Date.UTC(2095, 0, 1) + n * 3_600_000 + 1_800_000).toISOString() });
const ago = (days) => addDays(businessDate(), -days);

async function setup() {
  const admin = await setupUser();
  const secretary = await setupUser({ role: 'secretary', clinic: admin.clinic });
  const dentist = await createDentist(admin.clinic, { name: 'Dr. Paulo' });
  const patient = await createPatient(admin.clinic, { name: 'Ana Lima' });
  const procedure = await createProcedure(admin.clinic, { name: 'Restauração', price_cents: 50000 });
  const budget = (await api().post('/api/budgets').set(admin.headers).send({ patientId: patient.id, dentistId: dentist.dentist.id, items: [{ procedureId: procedure.id }] })).body;
  await api().post(`/api/budgets/${budget.id}/status`).set(admin.headers).send({ status: 'approved' });
  const dentistHeaders = await headersOf(dentist.user);
  const charge = async (dueDate, amountCents = 5000) => (await api().post(`/api/budgets/${budget.id}/payments`).set(admin.headers).send({ amountCents, dueDate })).body;
  const standing = async (headers = admin.headers) => (await api().get(`/api/patients/${patient.id}/standing`).set(headers)).body;
  const book = (headers, n = 1, extra = {}) => api().post('/api/appointments').set(headers).send({ patientId: patient.id, dentistId: dentist.dentist.id, ...start(n), ...extra });
  const begin = (id) => api().post(`/api/appointments/${id}/status`).set(dentistHeaders).send({ status: 'in_progress' });
  const release = (headers, body) => api().post(`/api/patients/${patient.id}/block-release`).set(headers).send(body);
  return { admin, secretary, dentist, patient, budget, dentistHeaders, charge, standing, book, begin, release };
}

describe('adimplência: quando o paciente fica bloqueado', () => {
  it('sem parcelas, ou só com parcelas em dia, não bloqueia', async () => {
    const c = await setup();
    expect(await c.standing()).toMatchObject({ blocked: false, overdue: false, overdueCents: 0, overdueCount: 0, oldestDueDate: null, graceDays: 7, releasedUntil: null, releaseReason: null });
    await c.charge(ago(3)); // venceu há 3 dias, dentro da tolerância
    await c.charge(addDays(businessDate(), 30));
    expect((await c.standing()).blocked).toBe(false);
    expect((await c.book(c.admin.headers)).status).toBe(201);
  });

  it('a tolerância é de 7 dias: exatamente 7 de atraso ainda passa, 8 bloqueia', async () => {
    const c = await setup();
    await c.charge(ago(7));
    expect((await c.standing()).blocked).toBe(false);
    await c.charge(ago(8), 3000);
    expect(await c.standing()).toMatchObject({ blocked: true, overdue: true, overdueCount: 1, overdueCents: 3000, oldestDueDate: ago(8) });
  });

  it('soma só o que está pendente e atrasado: pago, cancelado e futuro não contam', async () => {
    const c = await setup();
    const paid = await c.charge(ago(20));
    const canceled = await c.charge(ago(20), 1000);
    await c.charge(ago(15), 2000);
    await c.charge(ago(10), 4000);
    await api().post(`/api/payments/${paid.id}/pay`).set(c.admin.headers).send({ method: 'pix' });
    await api().post(`/api/payments/${canceled.id}/cancel`).set(c.admin.headers).send({});
    expect(await c.standing()).toMatchObject({ blocked: true, overdueCount: 2, overdueCents: 6000, oldestDueDate: ago(15) });
  });

  it('regularizar desbloqueia sozinho: pagar a parcela ou renegociar o vencimento', async () => {
    const c = await setup();
    const late = await c.charge(ago(30));
    expect((await c.standing()).blocked).toBe(true);
    await api().patch(`/api/payments/${late.id}`).set(c.secretary.headers).send({ dueDate: addDays(businessDate(), 5) }); // renegociou
    expect((await c.standing()).blocked).toBe(false);
    const another = await c.charge(ago(30));
    expect((await c.standing()).blocked).toBe(true);
    await api().post(`/api/payments/${another.id}/pay`).set(c.secretary.headers).send({ method: 'cash' });
    expect((await c.standing()).blocked).toBe(false);
  });

  it('a tolerância é da clínica: o administrador muda (0 a 60) e vale para todos os pacientes', async () => {
    const c = await setup();
    await c.charge(ago(3));
    expect((await c.standing()).blocked).toBe(false);
    const changed = await api().patch('/api/clinic').set(c.admin.headers).send({ overdueGraceDays: 2 });
    expect(changed.body.overdueGraceDays).toBe(2);
    expect(await c.standing()).toMatchObject({ blocked: true, graceDays: 2 });
    await api().patch('/api/clinic').set(c.admin.headers).send({ overdueGraceDays: 0 });
    for (const bad of [-1, 61, 1.5, '7']) expect((await api().patch('/api/clinic').set(c.admin.headers).send({ overdueGraceDays: bad })).status).toBe(400);
    expect((await api().get('/api/clinic').set(c.admin.headers)).body.overdueGraceDays).toBe(0);
  });
});

describe('o que o bloqueio impede', () => {
  it('novo agendamento: 409 PATIENT_BLOCKED, para qualquer perfil, com a mensagem de cada um', async () => {
    const c = await setup();
    await c.charge(ago(30));
    for (const headers of [c.admin.headers, c.secretary.headers]) {
      const res = await c.book(headers);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PATIENT_BLOCKED');
      expect(res.body.error).toMatch(/liberação ao administrador/);
    }
    const byDentist = await c.book(c.dentistHeaders, 1, { dentistId: undefined });
    expect(byDentist.status).toBe(409);
    expect(byDentist.body.code).toBe('PATIENT_BLOCKED');
    expect(byDentist.body.error).toBe('Paciente com pendência financeira. Encaminhe-o à recepção.'); // sem valores nem prazos
    expect(await db('appointments').count({ n: '*' }).first()).toMatchObject({ n: '0' });
  });

  it('iniciar um atendimento já marcado: 409, e nada muda; pagando, o mesmo atendimento começa', async () => {
    const c = await setup();
    const a = (await c.book(c.admin.headers)).body; // marcado quando ainda estava em dia
    const late = await c.charge(ago(30));
    const blocked = await c.begin(a.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'PATIENT_BLOCKED', error: 'Paciente com pendência financeira. Encaminhe-o à recepção.' });
    expect((await api().get(`/api/appointments/${a.id}`).set(c.admin.headers)).body).toMatchObject({ status: 'scheduled', startedAt: null });
    await api().post(`/api/payments/${late.id}/pay`).set(c.secretary.headers).send({ method: 'pix' });
    expect((await c.begin(a.id)).body.status).toBe('in_progress');
  });

  it('cancelar, remarcar e receber continuam permitidos com o paciente bloqueado', async () => {
    const c = await setup();
    const a = (await c.book(c.admin.headers)).body;
    const b = (await c.book(c.admin.headers, 5)).body;
    const late = await c.charge(ago(30));
    expect((await api().patch(`/api/appointments/${a.id}`).set(c.secretary.headers).send(start(9))).status).toBe(200);
    expect((await api().post(`/api/appointments/${b.id}/status`).set(c.secretary.headers).send({ status: 'canceled' })).status).toBe(200);
    expect((await api().post(`/api/payments/${late.id}/pay`).set(c.secretary.headers).send({ method: 'cash' })).status).toBe(200);
  });

  it('atendimento já iniciado não é interrompido: o bloqueio só vale ao iniciar', async () => {
    const c = await setup();
    const a = (await c.book(c.admin.headers)).body;
    expect((await c.begin(a.id)).status).toBe(200);
    await c.charge(ago(30)); // a parcela venceu no meio do atendimento
    const done = await api().post(`/api/appointments/${a.id}/status`).set(c.dentistHeaders).send({ status: 'attended', evolution: { procedures: [{ procedureId: c.budget.items[0].procedure.id, teeth: [16] }] } });
    expect(done.status).toBe(200);
  });
});

describe('liberação do bloqueio (só o administrador)', () => {
  it('exceção com motivo: agenda e inicia o atendimento enquanto durar, e a situação mostra a liberação', async () => {
    const c = await setup();
    await c.charge(ago(30));
    const res = await c.release(c.admin.headers, { reason: 'Urgência: dor aguda', days: 2 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ blocked: false, overdue: true, releaseReason: 'Urgência: dor aguda' });
    const days = (new Date(res.body.releasedUntil) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(1.9);
    expect(days).toBeLessThanOrEqual(2);
    const a = await c.book(c.secretary.headers);
    expect(a.status).toBe(201);
    expect((await c.begin(a.body.id)).status).toBe(200);
    expect(await db('audit_log').where({ entity: 'block_release' }).count({ n: '*' }).first()).toMatchObject({ n: '1' });
  });

  it('o prazo padrão é de 1 dia; liberação vencida volta a bloquear; vale a mais recente', async () => {
    const c = await setup();
    await c.charge(ago(30));
    const res = await c.release(c.admin.headers, { reason: 'Dor' });
    expect((new Date(res.body.releasedUntil) - Date.now()) / 86_400_000).toBeLessThanOrEqual(1);
    await db('block_releases').update({ valid_until: new Date(Date.now() - 1000) }); // venceu
    expect(await c.standing()).toMatchObject({ blocked: true, releasedUntil: null, releaseReason: null });
    await c.release(c.admin.headers, { reason: 'Curta', days: 1 });
    await db('block_releases').insert({ clinic_id: c.admin.clinic.id, patient_id: c.patient.id, reason: 'Longa', valid_until: new Date(Date.now() + 10 * 86_400_000), released_by: c.admin.user.id });
    expect(await c.standing()).toMatchObject({ blocked: false, releaseReason: 'Longa' });
  });

  it('secretária e dentista não liberam (403); paciente em dia não precisa (409 NOT_BLOCKED); valida o corpo (400); paciente inexistente (404)', async () => {
    const c = await setup();
    expect((await c.release(c.admin.headers, { reason: 'Sem pendência' })).body.code).toBe('NOT_BLOCKED');
    await c.charge(ago(30));
    for (const headers of [c.secretary.headers, c.dentistHeaders]) expect((await c.release(headers, { reason: 'Quero' })).status).toBe(403);
    for (const bad of [{}, { reason: 'ok' }, { reason: '   ' }, { reason: 'x'.repeat(241) }, { reason: 'Dor', days: 0 }, { reason: 'Dor', days: 31 }, { reason: 'Dor', days: 1.5 }]) {
      expect((await c.release(c.admin.headers, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await c.standing()).blocked).toBe(true);
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await api().post(`/api/patients/${missing}/block-release`).set(c.admin.headers).send({ reason: 'Dor' })).status).toBe(404);
    expect((await api().get(`/api/patients/${missing}/standing`).set(c.admin.headers)).status).toBe(404);
  });

  it('a situação financeira é da administração: o dentista recebe 403', async () => {
    const c = await setup();
    expect((await api().get(`/api/patients/${c.patient.id}/standing`).set(c.dentistHeaders)).status).toBe(403);
    expect((await c.standing(c.secretary.headers)).blocked).toBe(false);
  });
});
