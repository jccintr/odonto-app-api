import { afterEach, describe, expect, it, vi } from 'vitest';
import db from '../src/db/knex.js';
import { runReminders } from '../src/modules/notifications/notifications.reminders.js';
import { startReminderScheduler } from '../src/services/scheduler.js';
import { sendAppointmentReminderEmail } from '../src/services/mailer.js';
import { api, createPatient } from './helpers/factories.js';
import { HOUR, appointmentIn, notifications, setup } from './helpers/notices.js';

afterEach(() => vi.useRealTimers());

const zero = { noEmail: 0, noConsent: 0, alreadyHandled: 0 };

describe('lembrete automático', () => {
  it('envia só dos atendimentos ativos dentro da janela (padrão 24 h), uma vez cada', async () => {
    const c = await setup();
    const inside = [await appointmentIn(c, 1), await appointmentIn(c, 23)];
    await appointmentIn(c, 30); // longe demais
    await appointmentIn(c, -2); // já passou
    await appointmentIn(c, 5, { status: 'canceled' });
    await appointmentIn(c, 6, { status: 'attended' });
    await appointmentIn(c, 7, { status: 'no_show' });

    const summary = await runReminders();
    expect(summary).toEqual({ alreadyRunning: false, clinics: 1, considered: 2, sent: 2, failed: 0, skipped: zero });
    expect(sendAppointmentReminderEmail).toHaveBeenCalledTimes(2);
    const rows = await notifications(c);
    expect(rows.map((r) => [r.appointment_id, r.trigger, r.status, r.attempts]).sort()).toEqual(inside.map((a) => [a.id, 'auto', 'sent', 1]).sort());

    // segunda rodada: ninguém recebe de novo
    expect(await runReminders()).toMatchObject({ considered: 0, sent: 0 });
    expect(sendAppointmentReminderEmail).toHaveBeenCalledTimes(2);
  });

  it('a janela é configurável por clínica', async () => {
    const c = await setup();
    await appointmentIn(c, 30);
    await api().patch('/api/notifications/settings').set(c.headers).send({ reminderHoursBefore: 48 });
    expect((await runReminders()).sent).toBe(1);
    const narrow = await setup();
    await appointmentIn(narrow, 5);
    await api().patch('/api/notifications/settings').set(narrow.headers).send({ reminderHoursBefore: 2 });
    expect((await runReminders({ clinicId: narrow.clinic.id })).considered).toBe(0);
  });

  it('usa a hora informada (now) para decidir a janela', async () => {
    const c = await setup();
    await appointmentIn(c, 100, { from: 0 });
    expect((await runReminders({ now: new Date(70 * HOUR) })).considered).toBe(0); // faltam 30 h: fora da janela
    expect((await runReminders({ now: new Date(80 * HOUR) })).sent).toBe(1); // faltam 20 h: dentro
  });

  it('respeita a clínica que desligou os lembretes e ignora clínica suspensa', async () => {
    const off = await setup();
    const suspended = await setup();
    const on = await setup();
    for (const c of [off, suspended, on]) await appointmentIn(c, 5);
    await api().patch('/api/notifications/settings').set(off.headers).send({ remindersEnabled: false });
    await db('clinics').where({ id: suspended.clinic.id }).update({ status: 'suspended' });

    const summary = await runReminders();
    expect(summary).toMatchObject({ clinics: 1, sent: 1 });
    expect(await notifications(off)).toHaveLength(0);
    expect(await notifications(suspended)).toHaveLength(0);
    expect(await notifications(on)).toHaveLength(1);
  });

  it('com clinicId, roda só aquela clínica', async () => {
    const a = await setup();
    const b = await setup();
    await appointmentIn(a, 5);
    await appointmentIn(b, 5);
    expect((await runReminders({ clinicId: a.clinic.id })).sent).toBe(1);
    expect(await notifications(b)).toHaveLength(0);
  });

  it('não envia para paciente sem e-mail ou sem autorização de contato, e conta o motivo (sem gravar aviso)', async () => {
    const c = await setup();
    const noEmail = await createPatient(c.clinic, { name: 'Sem e-mail', contact_consent: true });
    const noConsent = await createPatient(c.clinic, { name: 'Sem aceite', email: 'x@exemplo.test' });
    await appointmentIn(c, 3, { patient: noEmail });
    await appointmentIn(c, 4, { patient: noConsent });
    await appointmentIn(c, 5);
    expect(await runReminders()).toMatchObject({ considered: 3, sent: 1, skipped: { noEmail: 1, noConsent: 1, alreadyHandled: 0 } });
    expect(await notifications(c)).toHaveLength(1);
  });

  it('quem já recebeu o lembrete à mão, da secretária, não recebe o automático', async () => {
    const c = await setup();
    const appointment = await appointmentIn(c, 5);
    await api().post(`/api/notifications/appointments/${appointment.id}/reminder`).set(c.headers).send({});
    expect(await runReminders()).toMatchObject({ considered: 0, sent: 0 });
    expect(await notifications(c)).toHaveLength(1);
  });

  it('falha: tenta de novo na rodada seguinte (mesmo registro) e desiste depois de 3 tentativas', async () => {
    const c = await setup();
    const appointment = await appointmentIn(c, 5);
    sendAppointmentReminderEmail.mockRejectedValue(new Error('SMTP fora do ar'));

    expect(await runReminders()).toMatchObject({ sent: 0, failed: 1 });
    expect(await runReminders()).toMatchObject({ failed: 1 });
    expect((await notifications(c))[0]).toMatchObject({ status: 'failed', attempts: 2, last_error: 'SMTP fora do ar' });

    sendAppointmentReminderEmail.mockResolvedValue({});
    expect(await runReminders()).toMatchObject({ sent: 1, failed: 0 });
    const [row, ...others] = await notifications(c);
    expect(others).toEqual([]);
    expect(row).toMatchObject({ appointment_id: appointment.id, status: 'sent', attempts: 3, last_error: null });
  });

  it('depois de 3 falhas não insiste mais', async () => {
    const c = await setup();
    await appointmentIn(c, 5);
    sendAppointmentReminderEmail.mockRejectedValue(new Error('fora'));
    for (let i = 0; i < 3; i += 1) await runReminders();
    sendAppointmentReminderEmail.mockClear();
    expect(await runReminders()).toMatchObject({ considered: 1, failed: 0, skipped: { ...zero, alreadyHandled: 1 } });
    expect(sendAppointmentReminderEmail).not.toHaveBeenCalled();
    expect((await notifications(c))[0].attempts).toBe(3);
  });

  it('envio "pendente" recente é respeitado; o parado há mais de 15 minutos (servidor caiu) é retomado', async () => {
    const c = await setup();
    const appointment = await appointmentIn(c, 5);
    const [{ id }] = await db('notifications').insert({
      clinic_id: c.clinic.id, patient_id: c.patient.id, kind: 'appointment_reminder', appointment_id: appointment.id, trigger: 'auto',
      recipient: 'ana@exemplo.test', subject: 'x', status: 'pending', attempts: 1,
    }).returning('id');

    expect(await runReminders()).toMatchObject({ sent: 0, skipped: { ...zero, alreadyHandled: 1 } });
    await db('notifications').where({ id }).update({ updated_at: new Date(Date.now() - 16 * 60_000) });
    expect(await runReminders()).toMatchObject({ sent: 1 });
    expect(await db('notifications').where({ id }).first()).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('duas execuções ao mesmo tempo: só uma trabalha (a outra sai sem fazer nada)', async () => {
    const c = await setup();
    await appointmentIn(c, 5);
    // uma "execução" em andamento = alguém segurando o travamento
    const result = await db.transaction(async (holder) => {
      await holder.raw('SELECT pg_advisory_xact_lock(727001)');
      return runReminders();
    });
    expect(result).toEqual({ alreadyRunning: true });
    expect(await notifications(c)).toHaveLength(0);
    expect((await runReminders()).sent).toBe(1); // liberado, volta a funcionar
  });

  it('muitas execuções em paralelo nunca duplicam o lembrete', async () => {
    const c = await setup();
    for (const hours of [2, 3, 4]) await appointmentIn(c, hours);
    const results = await Promise.all(Array.from({ length: 6 }, () => runReminders()));
    expect(results.reduce((total, r) => total + (r.sent ?? 0), 0)).toBe(3);
    expect(await notifications(c)).toHaveLength(3);
    expect(sendAppointmentReminderEmail).toHaveBeenCalledTimes(3);
  });

  it('o banco só aceita um lembrete automático por atendimento', async () => {
    const c = await setup();
    const appointment = await appointmentIn(c, 5);
    const row = { clinic_id: c.clinic.id, patient_id: c.patient.id, kind: 'appointment_reminder', appointment_id: appointment.id, recipient: 'a@b.test', subject: 'x' };
    await db('notifications').insert({ ...row, trigger: 'auto' });
    await expect(db('notifications').insert({ ...row, trigger: 'auto' })).rejects.toThrow();
    await db('notifications').insert({ ...row, trigger: 'manual' }); // à mão pode repetir
  });
});

describe('POST /api/notifications/reminders/run', () => {
  it('o administrador roda os lembretes da própria clínica e vê o resumo', async () => {
    const c = await setup();
    const other = await setup();
    await appointmentIn(c, 5);
    await appointmentIn(other, 5);
    const res = await api().post('/api/notifications/reminders/run').set(c.headers).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ alreadyRunning: false, clinics: 1, considered: 1, sent: 1, failed: 0, skipped: zero });
    expect(await notifications(other)).toHaveLength(0);
  });
});

describe('agendador', () => {
  const quiet = () => ({ log: vi.spyOn(console, 'log').mockImplementation(() => {}), error: vi.spyOn(console, 'error').mockImplementation(() => {}) });

  it('roda logo ao ligar e a cada intervalo, e para quando desligado', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue({ sent: 0, failed: 0 });
    const stop = startReminderScheduler({ run, intervalMinutes: 10 });
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('registra o resultado quando houve envio e sobrevive a erro no ciclo', async () => {
    vi.useFakeTimers();
    const { log, error } = quiet();
    const run = vi.fn().mockResolvedValueOnce({ sent: 3, failed: 1 }).mockRejectedValueOnce(new Error('banco caiu')).mockResolvedValue({ sent: 0, failed: 0 });
    const stop = startReminderScheduler({ run, intervalMinutes: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(log).toHaveBeenCalledWith('Lembretes: 3 enviados, 1 com falha.');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(error).toHaveBeenCalledWith('Lembretes: falha no ciclo —', 'banco caiu');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(1);
    stop();
  });

  it('com a configuração padrão, usa o intervalo do ambiente e o runReminders de verdade', async () => {
    vi.useFakeTimers();
    vi.stubEnv('REMINDERS_INTERVAL_MINUTES', '5');
    const stop = startReminderScheduler();
    await vi.advanceTimersByTimeAsync(1);
    stop();
    vi.unstubAllEnvs();
  });
});
