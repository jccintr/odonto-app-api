import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { sendAppointmentReminderEmail, sendBudgetEmail } from '../src/services/mailer.js';
import { api, createPatient, setupUser } from './helpers/factories.js';
import { appointmentIn, budgetWith, notifications, setup } from './helpers/notices.js';

const NOBODY = '0b0d2f7e-8f7b-4d49-9d63-3c2f1f2a1b11';
const reminder = (c, appointment, headers = c.headers) => api().post(`/api/notifications/appointments/${appointment.id}/reminder`).set(headers).send({});
const budgetEmail = (c, budget) => api().post(`/api/notifications/budgets/${budget.id}/email`).set(c.headers).send({});

describe('configuração dos avisos', () => {
  it('sem nada salvo, devolve os padrões; altera só o que foi enviado', async () => {
    const c = await setup();
    expect((await api().get('/api/notifications/settings').set(c.headers)).body).toEqual({ remindersEnabled: true, reminderHoursBefore: 24, contactPhone: null, contactAddress: null });
    await api().patch('/api/notifications/settings').set(c.headers).send({ reminderHoursBefore: 48 });
    const res = await api().patch('/api/notifications/settings').set(c.headers).send({ contactPhone: '(35) 3333-0000', contactAddress: 'Rua A, 10 — Brazópolis' });
    expect(res.body).toEqual({ remindersEnabled: true, reminderHoursBefore: 48, contactPhone: '(35) 3333-0000', contactAddress: 'Rua A, 10 — Brazópolis' });
    const off = await api().patch('/api/notifications/settings').set(c.headers).send({ remindersEnabled: false, contactPhone: null });
    expect(off.body).toMatchObject({ remindersEnabled: false, contactPhone: null, reminderHoursBefore: 48 });
    expect(await db('notification_settings')).toHaveLength(1);
    const log = await db('audit_log').where({ entity: 'notification_settings' }).orderBy('created_at');
    expect(log.map((l) => l.changes.fields)).toEqual([['reminderHoursBefore'], ['contactPhone', 'contactAddress'], ['remindersEnabled', 'contactPhone']]);
  });

  it('a secretária consulta, mas só o administrador altera; cada clínica tem a sua', async () => {
    const c = await setup();
    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });
    expect((await api().get('/api/notifications/settings').set(secretary.headers)).status).toBe(200);
    expect((await api().patch('/api/notifications/settings').set(secretary.headers).send({ reminderHoursBefore: 12 })).status).toBe(403);
    await api().patch('/api/notifications/settings').set(c.headers).send({ reminderHoursBefore: 12 });
    const other = await setupUser();
    expect((await api().get('/api/notifications/settings').set(other.headers)).body.reminderHoursBefore).toBe(24);
  });

  it.each([
    ['corpo vazio', {}], ['0 horas', { reminderHoursBefore: 0 }], ['73 horas', { reminderHoursBefore: 73 }], ['horas fracionadas', { reminderHoursBefore: 1.5 }],
    ['liga/desliga que não é booleano', { remindersEnabled: 'sim' }], ['telefone enorme', { contactPhone: 'x'.repeat(21) }], ['endereço enorme', { contactAddress: 'x'.repeat(241) }],
  ])('recusa %s', async (_, body) => {
    const c = await setup();
    expect((await api().patch('/api/notifications/settings').set(c.headers).send(body)).status).toBe(400);
  });
});

describe('POST /notifications/appointments/:id/reminder', () => {
  it('envia o lembrete, com data no fuso da clínica e contato da clínica, e registra', async () => {
    const c = await setup();
    await api().patch('/api/notifications/settings').set(c.headers).send({ contactPhone: '(35) 3333-0000', contactAddress: 'Rua A, 10' });
    const appointment = await appointmentIn(c, 5);
    const res = await reminder(c, appointment);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'appointment_reminder', channel: 'email', trigger: 'manual', patient: { name: 'Ana Lima' }, appointmentId: appointment.id, budgetId: null,
      recipient: 'ana@exemplo.test', status: 'sent', attempts: 1, lastError: null,
    });
    expect(res.body.sentAt).toBeTruthy();
    expect(sendAppointmentReminderEmail).toHaveBeenCalledWith({
      to: 'ana@exemplo.test', patientName: 'Ana Lima', clinicName: c.clinic.name, dentistName: 'Dr. Paulo',
      when: expect.stringMatching(/\d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}$/), address: 'Rua A, 10', phone: '(35) 3333-0000',
    });
    expect(await db('audit_log').where({ entity: 'notification', action: 'create' })).toHaveLength(1);
  });

  it('se o e-mail falhar, o registro fica como "failed" com o motivo (resposta 201) e dá para tentar de novo', async () => {
    const c = await setup();
    const appointment = await appointmentIn(c, 5);
    sendAppointmentReminderEmail.mockRejectedValueOnce(new Error('Connection timeout'));
    const failed = await reminder(c, appointment);
    expect(failed.status).toBe(201);
    expect(failed.body).toMatchObject({ status: 'failed', attempts: 1, lastError: 'Connection timeout', sentAt: null });
    expect((await reminder(c, appointment)).body.status).toBe('sent');
    expect(await notifications(c)).toHaveLength(2);
  });

  it('sem SMTP configurado (e-mail não enviado), também fica como falha', async () => {
    const c = await setup();
    sendAppointmentReminderEmail.mockResolvedValueOnce({ skipped: true });
    expect((await reminder(c, await appointmentIn(c, 5))).body).toMatchObject({ status: 'failed', lastError: 'SMTP não configurado' });
  });

  it('só avisa paciente com e-mail e que autorizou contato', async () => {
    const c = await setup();
    const noEmail = await createPatient(c.clinic, { name: 'Sem e-mail', contact_consent: true });
    const noConsent = await createPatient(c.clinic, { name: 'Sem aceite', email: 'x@exemplo.test', contact_consent: false });
    const a = await reminder(c, await appointmentIn(c, 5, { patient: noEmail }));
    const b = await reminder(c, await appointmentIn(c, 6, { patient: noConsent }));
    expect([a.status, a.body.code, b.status, b.body.code]).toEqual([422, 'NO_EMAIL', 422, 'NO_CONSENT']);
    expect(sendAppointmentReminderEmail).not.toHaveBeenCalled();
    expect(await notifications(c)).toHaveLength(0);
  });

  it('não avisa de atendimento passado, cancelado ou já realizado', async () => {
    const c = await setup();
    for (const [hours, status] of [[-2, 'scheduled'], [5, 'canceled'], [6, 'attended'], [7, 'no_show']]) {
      const res = await reminder(c, await appointmentIn(c, hours, { status }));
      expect([res.status, res.body.code], `${hours}h ${status}`).toEqual([409, 'APPOINTMENT_NOT_UPCOMING']);
    }
    expect(await notifications(c)).toHaveLength(0);
  });

  it('atendimento inexistente ou de outra clínica: 404', async () => {
    const c = await setup();
    const other = await setup();
    expect((await api().post(`/api/notifications/appointments/${NOBODY}/reminder`).set(c.headers).send({})).status).toBe(404);
    expect((await reminder(c, await appointmentIn(other, 5))).status).toBe(404);
  });
});

describe('POST /notifications/budgets/:id/email', () => {
  it('envia o orçamento com procedimentos, desconto e total', async () => {
    const c = await setup();
    const budget = await budgetWith(c, { teeth: [16, 26], discountCents: 5000 });
    const res = await budgetEmail(c, budget);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'budget', budgetId: budget.id, appointmentId: null, trigger: 'manual', status: 'sent', recipient: 'ana@exemplo.test' });
    expect(sendBudgetEmail).toHaveBeenCalledWith({
      to: 'ana@exemplo.test', patientName: 'Ana Lima', clinicName: c.clinic.name, dentistName: 'Dr. Paulo',
      items: [{ name: 'Restauração', tooth: 16, faces: null, priceCents: 20000 }, { name: 'Restauração', tooth: 26, faces: null, priceCents: 20000 }],
      subtotalCents: 40000, discountCents: 5000, totalCents: 35000, phone: null,
    });
  });

  it('só considera os procedimentos vigentes: item cancelado fica de fora', async () => {
    const c = await setup();
    const budget = await budgetWith(c, { teeth: [16, 26] });
    await api().post(`/api/budgets/${budget.id}/status`).set(c.headers).send({ status: 'approved' });
    await api().post(`/api/budgets/${budget.id}/items/${budget.items[1].id}/cancel`).set(c.headers);
    await budgetEmail(c, budget);
    expect(sendBudgetEmail.mock.calls[0][0]).toMatchObject({ items: [expect.objectContaining({ tooth: 16 })], subtotalCents: 20000, totalCents: 20000 });
  });

  it('falha do e-mail fica registrada; orçamento sem procedimento, sem e-mail ou sem aceite não é enviado', async () => {
    const c = await setup();
    const budget = await budgetWith(c);
    sendBudgetEmail.mockRejectedValueOnce(new Error('Mailbox full'));
    expect((await budgetEmail(c, budget)).body).toMatchObject({ status: 'failed', lastError: 'Mailbox full' });

    await api().post(`/api/budgets/${budget.id}/status`).set(c.headers).send({ status: 'approved' });
    await api().post(`/api/budgets/${budget.id}/items/${budget.items[0].id}/cancel`).set(c.headers);
    const empty = await budgetEmail(c, budget);
    expect([empty.status, empty.body.code]).toEqual([422, 'NO_ITEMS']);

    const noEmail = await createPatient(c.clinic, { name: 'Sem e-mail', contact_consent: true });
    const noConsent = await createPatient(c.clinic, { name: 'Sem aceite', email: 'x@exemplo.test' });
    expect((await budgetEmail(c, await budgetWith(c, { patient: noEmail }))).body.code).toBe('NO_EMAIL');
    expect((await budgetEmail(c, await budgetWith(c, { patient: noConsent }))).body.code).toBe('NO_CONSENT');
  });

  it('orçamento inexistente ou de outra clínica: 404', async () => {
    const c = await setup();
    const other = await setup();
    expect((await api().post(`/api/notifications/budgets/${NOBODY}/email`).set(c.headers).send({})).status).toBe(404);
    expect((await budgetEmail(c, await budgetWith(other))).status).toBe(404);
  });
});

describe('links de WhatsApp (wa.me, sem custo)', () => {
  const whatsapp = (c, path) => api().get(`/api/notifications/${path}/whatsapp`).set(c.headers);

  it('lembrete: link com o telefone (DDI 55) e a mensagem pronta; não grava aviso', async () => {
    const c = await setup();
    const appointment = await appointmentIn(c, 5);
    const res = await whatsapp(c, `appointments/${appointment.id}`);
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('5535999990000');
    expect(res.body.message).toMatch(/^Olá, Ana Lima! Lembrete da sua consulta na .+ com Dr\. Paulo: .+ às \d{2}:\d{2}\./);
    expect(res.body.url).toBe(`https://wa.me/5535999990000?text=${encodeURIComponent(res.body.message)}`);
    expect(await notifications(c)).toHaveLength(0);
  });

  it('orçamento: mensagem com itens, desconto e total', async () => {
    const c = await setup();
    const budget = await budgetWith(c, { teeth: [16], discountCents: 2500 });
    const { message, url } = (await whatsapp(c, `budgets/${budget.id}`)).body;
    expect(message.split('\n')).toEqual([
      `Olá, Ana Lima! Segue o orçamento do seu tratamento com Dr. Paulo (${c.clinic.name}):`,
      '- Restauração dente 16: R$ 200,00', 'Desconto: -R$ 25,00', 'Total: R$ 175,00',
    ]);
    expect(url).toContain('https://wa.me/5535999990000?text=');
  });

  it('orçamento sem desconto e procedimento sem dente: a mensagem não inventa linhas', async () => {
    const c = await setup();
    const budget = await budgetWith(c, { teeth: [undefined] });
    const { message } = (await api().get(`/api/notifications/budgets/${budget.id}/whatsapp`).set(c.headers)).body;
    expect(message.split('\n')).toEqual([
      `Olá, Ana Lima! Segue o orçamento do seu tratamento com Dr. Paulo (${c.clinic.name}):`, '- Restauração: R$ 200,00', 'Total: R$ 200,00',
    ]);
  });

  it('sem telefone, sem aceite, atendimento passado, orçamento vazio ou inexistente: erro claro', async () => {
    const c = await setup();
    const noPhone = await createPatient(c.clinic, { name: 'Sem telefone', contact_consent: true });
    const noConsent = await createPatient(c.clinic, { name: 'Sem aceite', phone: '35988887777' });
    expect((await whatsapp(c, `appointments/${(await appointmentIn(c, 5, { patient: noPhone })).id}`)).body.code).toBe('NO_PHONE');
    expect((await whatsapp(c, `appointments/${(await appointmentIn(c, 6, { patient: noConsent })).id}`)).body.code).toBe('NO_CONSENT');
    expect((await whatsapp(c, `appointments/${(await appointmentIn(c, -3)).id}`)).body.code).toBe('APPOINTMENT_NOT_UPCOMING');
    expect((await whatsapp(c, `budgets/${(await budgetWith(c, { patient: noPhone })).id}`)).body.code).toBe('NO_PHONE');
    expect((await whatsapp(c, `budgets/${(await budgetWith(c, { patient: noConsent })).id}`)).body.code).toBe('NO_CONSENT');
    expect((await whatsapp(c, `appointments/${NOBODY}`)).status).toBe(404);
    expect((await whatsapp(c, `budgets/${NOBODY}`)).status).toBe(404);

    const budget = await budgetWith(c);
    await api().post(`/api/budgets/${budget.id}/status`).set(c.headers).send({ status: 'approved' });
    await api().post(`/api/budgets/${budget.id}/items/${budget.items[0].id}/cancel`).set(c.headers);
    expect((await whatsapp(c, `budgets/${budget.id}`)).body.code).toBe('NO_ITEMS');
  });
});

describe('GET /notifications (histórico)', () => {
  it('lista do mais recente para o mais antigo, com filtros e paginação', async () => {
    const c = await setup();
    const other = await createPatient(c.clinic, { name: 'Bia', email: 'bia@exemplo.test', contact_consent: true });
    const first = await reminder(c, await appointmentIn(c, 5));
    sendBudgetEmail.mockRejectedValueOnce(new Error('falhou'));
    const second = await budgetEmail(c, await budgetWith(c));
    const third = await reminder(c, await appointmentIn(c, 6, { patient: other }));

    const all = (await api().get('/api/notifications').set(c.headers)).body;
    expect(all.data.map((n) => n.id)).toEqual([third.body.id, second.body.id, first.body.id]);
    expect(all).toMatchObject({ total: 3, page: 1, perPage: 20 });
    expect((await api().get('/api/notifications?kind=budget').set(c.headers)).body.data.map((n) => n.id)).toEqual([second.body.id]);
    expect((await api().get('/api/notifications?status=failed').set(c.headers)).body.data.map((n) => n.id)).toEqual([second.body.id]);
    expect((await api().get(`/api/notifications?patientId=${other.id}`).set(c.headers)).body.data.map((n) => n.id)).toEqual([third.body.id]);
    expect((await api().get('/api/notifications?perPage=1&page=3').set(c.headers)).body.data.map((n) => n.id)).toEqual([first.body.id]);
    for (const query of ['?kind=sms', '?status=ok', '?patientId=abc']) {
      expect((await api().get(`/api/notifications${query}`).set(c.headers)).status, query).toBe(400);
    }
  });

  it('a secretária também envia e consulta; o dentista não (ver matriz de segurança); clínicas não se misturam', async () => {
    const c = await setup();
    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });
    expect((await reminder(c, await appointmentIn(c, 5), secretary.headers)).status).toBe(201);
    expect((await api().get('/api/notifications').set(secretary.headers)).body.total).toBe(1);
    const other = await setupUser();
    expect((await api().get('/api/notifications').set(other.headers)).body.total).toBe(0);
  });

  it('o banco recusa aviso incoerente (tipo sem referência, canal, situação)', async () => {
    const c = await setup();
    const base = { clinic_id: c.clinic.id, patient_id: c.patient.id, trigger: 'manual', recipient: 'a@b.test', subject: 'x' };
    await expect(db('notifications').insert({ ...base, kind: 'budget' })).rejects.toThrow();
    await expect(db('notifications').insert({ ...base, kind: 'appointment_reminder', appointment_id: (await appointmentIn(c, 5)).id, channel: 'sms' })).rejects.toThrow();
    await expect(db('notifications').insert({ ...base, kind: 'sms', appointment_id: (await appointmentIn(c, 6)).id })).rejects.toThrow();
  });
});
