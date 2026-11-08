import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { api, createDentist, createPatient, createProcedure, setupUser } from './helpers/factories.js';
import { headersOf } from './helpers/execute.js';

async function setup() {
  const admin = await setupUser();
  const dentist = await createDentist(admin.clinic, { name: 'Dr. Paulo' });
  const filling = await createProcedure(admin.clinic, { name: 'Restauração', price_cents: 20000 });
  const clean = await createProcedure(admin.clinic, { name: 'Limpeza', price_cents: 10000 });
  return { ...admin, dentist, filling, clean };
}
const list = async (c) => (await api().get('/api/worklist').set(c.headers)).body;
async function budgetFor(c, patient, { approve = false, items = 1, discountCents = 0 } = {}) {
  const res = await api().post('/api/budgets').set(c.headers).send({
    patientId: patient.id, dentistId: c.dentist.dentist.id, discountCents,
    items: Array.from({ length: items }, () => ({ procedureId: c.filling.id })),
  });
  if (approve) await api().post(`/api/budgets/${res.body.id}/status`).set(c.headers).send({ status: 'approved' });
  return res.body;
}
const book = (c, patient, day, extra = {}) => api().post('/api/appointments').set(c.headers).send({
  patientId: patient.id, dentistId: c.dentist.dentist.id, startsAt: `2099-03-${day}T14:00:00.000Z`, endsAt: `2099-03-${day}T15:00:00.000Z`, ...extra,
});

describe('GET /api/worklist', () => {
  it('clínica nova: tudo vazio; dentista não acessa (403)', async () => {
    const c = await setup();
    expect(await list(c)).toEqual({ approvedWithoutAppointment: [], budgetsAwaitingAnswer: [], overdueWithAppointments: [] });
    const dentistHeaders = await headersOf(c.dentist.user);
    expect((await api().get('/api/worklist').set(dentistHeaders)).status).toBe(403);
  });

  it('aprovado sem consulta marcada aparece até agendar; arquivado e executado ficam de fora', async () => {
    const c = await setup();
    const ana = await createPatient(c.clinic, { name: 'Ana Lima' });
    const bia = await createPatient(c.clinic, { name: 'Bia Souza' });
    const old = await createPatient(c.clinic, { name: 'Arquivado' });
    await budgetFor(c, ana, { approve: true, items: 2 });
    await budgetFor(c, bia, { approve: true });
    await budgetFor(c, old, { approve: true });
    await api().patch(`/api/patients/${old.id}`).set(c.headers).send({ active: false });

    let rows = (await list(c)).approvedWithoutAppointment;
    expect(rows.map((r) => [r.patient.name, r.itemsCount])).toEqual(expect.arrayContaining([['Ana Lima', 2], ['Bia Souza', 1]]));
    expect(rows).toHaveLength(2);
    expect(rows[0].approvedSince).toBeTruthy();

    expect((await book(c, ana, '10')).status).toBe(201);
    rows = (await list(c)).approvedWithoutAppointment;
    expect(rows.map((r) => r.patient.name)).toEqual(['Bia Souza']);

    // consulta cancelada não conta como agendada
    const second = (await book(c, bia, '11')).body;
    await api().post(`/api/appointments/${second.id}/status`).set(c.headers).send({ status: 'canceled' });
    expect((await list(c)).approvedWithoutAppointment.map((r) => r.patient.name)).toEqual(['Bia Souza']);
  });

  it('orçamentos em aberto, os mais antigos primeiro, com valor e dias de espera; aprovados e recusados não entram', async () => {
    const c = await setup();
    const ana = await createPatient(c.clinic, { name: 'Ana Lima' });
    const bia = await createPatient(c.clinic, { name: 'Bia Souza' });
    const recent = await budgetFor(c, ana, { items: 2, discountCents: 5000 });
    const stale = await budgetFor(c, bia);
    await budgetFor(c, ana, { approve: true });
    const rejected = await budgetFor(c, bia);
    await api().post(`/api/budgets/${rejected.id}/status`).set(c.headers).send({ status: 'rejected' });
    await db('budgets').where({ id: stale.id }).update({ created_at: new Date(Date.now() - 6 * 86_400_000) });

    const rows = (await list(c)).budgetsAwaitingAnswer;
    expect(rows.map((r) => r.budgetId)).toEqual([stale.id, recent.id]);
    expect(rows[0]).toMatchObject({ patient: { name: 'Bia Souza' }, dentistName: 'Dr. Paulo', totalCents: 20000, daysOpen: 6 });
    expect(rows[1]).toMatchObject({ totalCents: 35000, daysOpen: 0 });
  });

  it('paciente em atraso com consulta marcada: só a próxima; liberado deixa de estar bloqueado; dentro da tolerância não entra', async () => {
    const c = await setup();
    const ana = await createPatient(c.clinic, { name: 'Ana Lima' });
    const bia = await createPatient(c.clinic, { name: 'Bia Souza' });
    const caio = await createPatient(c.clinic, { name: 'Caio Dias' });
    const dora = await createPatient(c.clinic, { name: 'Dora Reis' });
    const owe = async (patient, dueDate, amountCents = 5000) => {
      const b = await budgetFor(c, patient, { approve: true });
      await api().post(`/api/budgets/${b.id}/payments`).set(c.headers).send({ amountCents, dueDate });
    };
    await owe(ana, '2020-01-10', 7000);
    await owe(bia, '2020-02-10');
    await owe(caio, '2099-01-01'); // a vencer: não é atraso
    await owe(dora, '2020-03-10'); // em atraso, mas sem consulta marcada

    // as consultas são marcadas antes do atraso existir no sistema? não: o agendamento do bloqueado é recusado, então grava direto
    const insert = (patient, startsAt, status = 'scheduled') => db('appointments').insert({
      clinic_id: c.clinic.id, patient_id: patient.id, dentist_id: c.dentist.dentist.id, starts_at: startsAt, ends_at: new Date(new Date(startsAt).getTime() + 3_600_000), status,
    });
    await insert(ana, '2099-04-02T14:00:00Z');
    await insert(ana, '2099-04-01T14:00:00Z'); // a mais próxima
    await insert(bia, '2099-04-03T14:00:00Z');
    await insert(caio, '2099-04-04T14:00:00Z');
    await insert(dora, '2020-01-01T14:00:00Z'); // passada: não conta

    await api().post(`/api/patients/${bia.id}/block-release`).set(c.headers).send({ reason: 'Urgência', days: 2 });

    const rows = (await list(c)).overdueWithAppointments;
    expect(rows.map((r) => r.patient.name)).toEqual(['Ana Lima', 'Bia Souza']);
    expect(rows[0]).toMatchObject({ overdueCents: 7000, oldestDueDate: '2020-01-10', blocked: true, releasedUntil: null });
    expect(rows[0].nextAppointment.startsAt).toBe('2099-04-01T14:00:00.000Z');
    expect(rows[0].nextAppointment.dentistName).toBe('Dr. Paulo');
    expect(rows[1]).toMatchObject({ blocked: false });
    expect(rows[1].releasedUntil).not.toBeNull();
  });

  it('só enxerga a própria clínica', async () => {
    const c = await setup();
    const other = await setup();
    await budgetFor(other, await createPatient(other.clinic, { name: 'De outra clínica' }), { approve: true });
    await budgetFor(other, await createPatient(other.clinic, { name: 'Outro aberto' }));
    expect(await list(c)).toEqual({ approvedWithoutAppointment: [], budgetsAwaitingAnswer: [], overdueWithAppointments: [] });
  });
});
