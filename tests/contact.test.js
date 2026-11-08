import { describe, expect, it } from 'vitest';
import { api, bearer, createDentist, createPatient, loginAs, setupUser } from './helpers/factories.js';

const T = (h) => `2099-11-03T${String(h).padStart(2, '0')}:00:00.000Z`;

async function setup() {
  const admin = await setupUser();
  const secretary = await setupUser({ role: 'secretary', clinic: admin.clinic });
  const dentist = await createDentist(admin.clinic, { name: 'Dr. Paulo' });
  const patient = await createPatient(admin.clinic, { name: 'Ana Lima', phone: '35999990001', guardian_name: 'Maria', guardian_phone: '35999990009' });
  const headers = bearer((await loginAs(dentist.user)).accessToken);
  const appointment = (await api().post('/api/appointments').set(admin.headers).send({ patientId: patient.id, dentistId: dentist.dentist.id, startsAt: T(9), endsAt: T(10) })).body;
  return { admin, secretary, dentist, patient, headers, appointment };
}

describe('telefone do paciente: só administração e secretária', () => {
  it('na ficha e nas listas de pacientes o dentista recebe null; os demais recebem o número', async () => {
    const c = await setup();
    const asDentist = (await api().get(`/api/patients/${c.patient.id}`).set(c.headers)).body;
    expect(asDentist).toMatchObject({ name: 'Ana Lima', phone: null, guardianPhone: null, guardianName: 'Maria' });
    for (const who of [c.admin, c.secretary]) {
      expect((await api().get(`/api/patients/${c.patient.id}`).set(who.headers)).body).toMatchObject({ phone: '35999990001', guardianPhone: '35999990009' });
    }
    expect((await api().get('/api/patients').set(c.headers)).body.data[0]).toMatchObject({ name: 'Ana Lima', phone: null });
    expect((await api().get('/api/patients').set(c.secretary.headers)).body.data[0]).toMatchObject({ phone: '35999990001' });
  });

  it('o dentista não descobre o telefone buscando por ele; a secretária busca por telefone', async () => {
    const c = await setup();
    expect((await api().get('/api/patients?q=35999990001').set(c.headers)).body.total).toBe(0);
    expect((await api().get('/api/patients?q=35999990001').set(c.secretary.headers)).body.total).toBe(1);
    expect((await api().get('/api/patients?q=ana').set(c.headers)).body.total).toBe(1); // nome e CPF continuam
  });

  it('nos atendimentos (lista, consulta, criação, remarcação e situação) o dentista recebe phone null', async () => {
    const c = await setup();
    const id = c.appointment.id;
    expect((await api().get('/api/appointments').set(c.headers)).body.data[0].patient.phone).toBeNull();
    expect((await api().get(`/api/appointments/${id}`).set(c.headers)).body.patient.phone).toBeNull();
    expect((await api().patch(`/api/appointments/${id}`).set(c.headers).send({ notes: 'x' })).body.patient.phone).toBeNull();
    expect((await api().post(`/api/appointments/${id}/status`).set(c.headers).send({ status: 'confirmed' })).body.patient.phone).toBeNull();
    const created = await api().post('/api/appointments').set(c.headers).send({ patientId: c.patient.id, startsAt: T(12), endsAt: T(13) });
    expect(created.body.patient.phone).toBeNull();
    for (const who of [c.admin, c.secretary]) {
      expect((await api().get(`/api/appointments/${id}`).set(who.headers)).body.patient.phone).toBe('35999990001');
    }
  });

  it('o dentista não cadastra nem altera telefones (403); a ficha continua editável sem eles', async () => {
    const c = await setup();
    expect((await api().patch(`/api/patients/${c.patient.id}`).set(c.headers).send({ phone: '35988887777' })).status).toBe(403);
    expect((await api().patch(`/api/patients/${c.patient.id}`).set(c.headers).send({ guardianPhone: null })).status).toBe(403);
    expect((await api().post('/api/patients').set(c.headers).send({ name: 'Novo Paciente', phone: '35988887777' })).status).toBe(403);
    const edited = await api().patch(`/api/patients/${c.patient.id}`).set(c.headers).send({ notes: 'Prefere horário da manhã' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ notes: 'Prefere horário da manhã', phone: null });
    expect((await api().post('/api/patients').set(c.headers).send({ name: 'Novo Paciente' })).body.phone).toBeNull();
    // o número guardado não mudou
    expect((await api().get(`/api/patients/${c.patient.id}`).set(c.secretary.headers)).body.phone).toBe('35999990001');
  });
});
