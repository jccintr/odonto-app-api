import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { api, createClinic, createDentist, createPatient, setupUser } from './helpers/factories.js';

const onboarding = (s) => api().get('/api/clinic/onboarding').set(s.headers);
const done = (body) => Object.fromEntries(body.steps.map((step) => [step.key, step.done]));

describe('primeiros passos da clínica', () => {
  it('clínica sem modelo (criada pela plataforma) não tem o passo de preços', async () => {
    const s = await setupUser();
    const { body } = await onboarding(s);
    expect(body.steps.map((step) => step.key)).toEqual(['team', 'patient', 'appointment']);
    expect(body.completed).toBe(false);
    expect(done(body)).toEqual({ team: false, patient: false, appointment: false });
  });

  it('modelo com procedimentos pede para conferir os preços até a clínica confirmar', async () => {
    const clinic = await createClinic({ template_code: 'general' });
    const s = await setupUser({ clinic });
    const first = await onboarding(s);
    expect(first.body.steps[0]).toMatchObject({ key: 'prices', done: false });

    const res = await api().post('/api/clinic/onboarding/prices-reviewed').set(s.headers).send({});
    expect(res.status).toBe(200);
    expect(res.body.steps[0]).toMatchObject({ key: 'prices', done: true });
    expect((await db('clinics').where({ id: clinic.id }).first()).prices_reviewed_at).toBeInstanceOf(Date);
  });

  it('modelo vazio não pede conferência de preços', async () => {
    const s = await setupUser({ clinic: await createClinic({ template_code: 'empty' }) });
    expect((await onboarding(s)).body.steps.map((step) => step.key)).toEqual(['team', 'patient', 'appointment']);
  });

  it('cada passo é marcado quando a clínica faz', async () => {
    const s = await setupUser();
    const { dentist } = await createDentist(s.clinic);
    expect(done((await onboarding(s)).body)).toEqual({ team: true, patient: false, appointment: false });

    const patient = await createPatient(s.clinic);
    expect(done((await onboarding(s)).body)).toEqual({ team: true, patient: true, appointment: false });

    await db('appointments').insert({
      clinic_id: s.clinic.id, patient_id: patient.id, dentist_id: dentist.id, starts_at: '2099-01-01T10:00:00Z', ends_at: '2099-01-01T11:00:00Z',
    });
    const { body } = await onboarding(s);
    expect(body.completed).toBe(true);
  });

  it('só o administrador vê e confirma', async () => {
    const admin = await setupUser();
    const secretary = await setupUser({ role: 'secretary', clinic: admin.clinic });
    expect((await onboarding(secretary)).status).toBe(403);
    expect((await api().post('/api/clinic/onboarding/prices-reviewed').set(secretary.headers).send({})).status).toBe(403);
  });
});
