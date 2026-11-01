// Jornada completa pela API: do cadastro da clínica até o pagamento, passando por TODAS as rotas com sucesso.
// Cada resposta é conferida contra a documentação (helpers/contract.js). No fim, confirma que nenhuma rota ficou sem ser
// exercitada: rota nova que não entrar nesta jornada (ou na documentação) faz o teste falhar.
import { expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { signPlatformToken } from '../src/services/tokens.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../src/services/mailer.js';
import { spec, validated } from './helpers/contract.js';
import { fake } from './helpers/fakeStorage.js';
import { api, bearer, createPlatformAdmin } from './helpers/factories.js';

const tokenOf = (mock) => new URL(mock.mock.calls.at(-1)[0].url).searchParams.get('token');

it('percorre o sistema inteiro e todas as rotas respondem como a documentação promete', async () => {
  // por que um único teste: o banco é zerado entre testes, e a jornada é uma história contínua
  const step = async (label, request, status) => {
    const res = await request;
    expect(res.status, `${label}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(status);
    return res.body;
  };

  // ---- plataforma ----
  const platformAdmin = await createPlatformAdmin({ password: 'senha-da-plataforma-1' });
  const platformLogin = await step('plataforma login', api().post('/api/platform/login').send({ email: platformAdmin.email, password: 'senha-da-plataforma-1' }), 200);
  const platform = bearer(platformLogin.token);
  expect(platformLogin.token).toBe(signPlatformToken(platformAdmin)); // mesmo segredo e dono
  const created = await step('criar clínica', api().post('/api/platform/clinics').set(platform).send({
    name: 'Clínica Sorriso', admin: { name: 'Dra. Ana', email: 'ana@sorriso.test', password: 'senha-da-ana-123' },
  }), 201);
  await step('listar clínicas', api().get('/api/platform/clinics').set(platform), 200);
  await step('consultar clínica', api().get(`/api/platform/clinics/${created.clinic.id}`).set(platform), 200);
  await step('alterar clínica', api().patch(`/api/platform/clinics/${created.clinic.id}`).set(platform).send({ plan: 'premium' }), 200);

  // ---- autenticação ----
  await step('reenviar verificação', api().post('/api/auth/resend-verification').send({ email: 'ana@sorriso.test' }), 200);
  await step('verificar e-mail', api().post('/api/auth/verify-email').send({ token: tokenOf(sendVerificationEmail) }), 200);
  const login = await step('login', api().post('/api/auth/login').send({ email: 'ana@sorriso.test', password: 'senha-da-ana-123' }), 200);
  await step('meu perfil', api().get('/api/auth/me').set(bearer(login.accessToken)), 200);
  const refreshed = await step('renovar sessão', api().post('/api/auth/refresh').send({ refreshToken: login.refreshToken }), 200);
  await step('trocar senha', api().post('/api/auth/change-password').set(bearer(refreshed.accessToken)).send({ currentPassword: 'senha-da-ana-123', newPassword: 'senha-nova-456' }), 200);
  await step('esqueci a senha', api().post('/api/auth/forgot-password').send({ email: 'ana@sorriso.test' }), 200);
  await step('redefinir senha', api().post('/api/auth/reset-password').send({ token: tokenOf(sendPasswordResetEmail), newPassword: 'senha-final-789' }), 200);
  const session = await step('login após redefinir', api().post('/api/auth/login').send({ email: 'ana@sorriso.test', password: 'senha-final-789' }), 200);
  const admin = bearer(session.accessToken);
  await step('sair', api().post('/api/auth/logout').send({ refreshToken: session.refreshToken }), 204);

  // ---- clínica, usuários e dentistas ----
  await step('minha clínica', api().get('/api/clinic').set(admin), 200);
  await step('alterar minha clínica', api().patch('/api/clinic').set(admin).send({ document: '12.345.678/0001-90' }), 200);
  await step('criar secretária', api().post('/api/users').set(admin).send({ name: 'Maria Souza', email: 'maria@sorriso.test', password: 'senha-da-maria-1', role: 'secretary' }), 201);
  const dentistUser = await step('criar dentista', api().post('/api/users').set(admin).send({ name: 'Dr. Paulo', email: 'paulo@sorriso.test', password: 'senha-do-paulo-1', role: 'dentist' }), 201);
  await db('users').update({ email_verified_at: new Date() });
  await step('listar usuários', api().get('/api/users').set(admin), 200);
  await step('consultar usuário', api().get(`/api/users/${dentistUser.id}`).set(admin), 200);
  await step('alterar usuário', api().patch(`/api/users/${dentistUser.id}`).set(admin).send({ name: 'Dr. Paulo Lima' }), 200);
  const dentists = await step('listar dentistas', api().get('/api/dentists').set(admin), 200);
  const dentist = dentists[0];
  await step('consultar dentista', api().get(`/api/dentists/${dentist.id}`).set(admin), 200);
  await step('alterar dentista', api().patch(`/api/dentists/${dentist.id}`).set(admin).send({ cro: 'CRO-MG 12345', payoutPercent: 40 }), 200);

  // ---- procedimentos e pacientes ----
  const procedure = await step('criar procedimento', api().post('/api/procedures').set(admin).send({ name: 'Restauração', priceCents: 20000, odontogramCondition: 'restoration' }), 201);
  await step('listar procedimentos', api().get('/api/procedures').set(admin), 200);
  await step('consultar procedimento', api().get(`/api/procedures/${procedure.id}`).set(admin), 200);
  await step('alterar procedimento', api().patch(`/api/procedures/${procedure.id}`).set(admin).send({ category: 'Dentística' }), 200);
  const patient = await step('cadastrar paciente', api().post('/api/patients').set(admin).send({
    name: 'Ana Lima', cpf: '529.982.247-25', phone: '(35) 99999-0000', birthDate: '1990-05-17', contactConsent: true, anamnesis: { alergias: ['penicilina'] },
    address: { zip: '37530-000', city: 'Brazópolis', state: 'MG' },
  }), 201);
  await step('listar pacientes', api().get('/api/patients').set(admin), 200);
  await step('ficha do paciente', api().get(`/api/patients/${patient.id}`).set(admin), 200);
  await step('alterar paciente', api().patch(`/api/patients/${patient.id}`).set(admin).send({ notes: 'Prefere de manhã' }), 200);

  // ---- odontograma ----
  const mark = await step('marcar dente', api().post(`/api/patients/${patient.id}/odontogram`).set(admin).send({ tooth: 12, faces: 'od', condition: 'caries' }), 201);
  await step('ver odontograma', api().get(`/api/patients/${patient.id}/odontogram`).set(admin), 200);
  await step('remover marcação', api().delete(`/api/patients/${patient.id}/odontogram/${mark.id}`).set(admin), 204);

  // ---- imagens e radiografias ----
  const signed = await step('assinar envio', api().post(`/api/patients/${patient.id}/images/upload-signature`).set(admin).send({}), 200);
  fake.upload(signed.publicId, { bytes: 250_000, format: 'jpg' });
  const image = await step('registrar imagem', api().post(`/api/patients/${patient.id}/images`).set(admin).send({ publicId: signed.publicId, kind: 'xray', tooth: 16 }), 201);
  await step('listar imagens', api().get(`/api/patients/${patient.id}/images`).set(admin), 200);
  await step('consultar imagem', api().get(`/api/patients/${patient.id}/images/${image.id}`).set(admin), 200);
  await step('alterar imagem', api().patch(`/api/patients/${patient.id}/images/${image.id}`).set(admin).send({ notes: 'Periapical do 16' }), 200);
  await step('remover imagem', api().delete(`/api/patients/${patient.id}/images/${image.id}`).set(admin), 204);

  // ---- agenda ----
  const appointment = await step('agendar', api().post('/api/appointments').set(admin).send({
    patientId: patient.id, dentistId: dentist.id, startsAt: '2099-02-01T13:00:00.000Z', endsAt: '2099-02-01T14:00:00.000Z',
  }), 201);
  await step('listar atendimentos', api().get('/api/appointments').set(admin), 200);
  await step('consultar atendimento', api().get(`/api/appointments/${appointment.id}`).set(admin), 200);
  await step('remarcar', api().patch(`/api/appointments/${appointment.id}`).set(admin).send({ notes: 'Trazer exames' }), 200);
  await step('confirmar atendimento', api().post(`/api/appointments/${appointment.id}/status`).set(admin).send({ status: 'confirmed' }), 200);

  // ---- orçamento ----
  const budget = await step('criar orçamento', api().post('/api/budgets').set(admin).send({
    patientId: patient.id, dentistId: dentist.id, items: [{ procedureId: procedure.id, tooth: 16, faces: 'OD' }],
  }), 201);
  await step('listar orçamentos', api().get('/api/budgets').set(admin), 200);
  await step('consultar orçamento', api().get(`/api/budgets/${budget.id}`).set(admin), 200);
  await step('alterar orçamento', api().patch(`/api/budgets/${budget.id}`).set(admin).send({ discountCents: 1000, notes: 'Desconto combinado' }), 200);
  await step('incluir item B', api().post(`/api/budgets/${budget.id}/items`).set(admin).send({ procedureId: procedure.id, tooth: 26 }), 201);
  const withC = await step('incluir item C', api().post(`/api/budgets/${budget.id}/items`).set(admin).send({ procedureId: procedure.id, tooth: 36 }), 201);
  const [itemA, itemB, itemC] = withC.items;
  await step('alterar item', api().patch(`/api/budgets/${budget.id}/items/${itemB.id}`).set(admin).send({ priceCents: 15000 }), 200);
  await step('remover item', api().delete(`/api/budgets/${budget.id}/items/${itemC.id}`).set(admin), 200);
  await step('aprovar orçamento', api().post(`/api/budgets/${budget.id}/status`).set(admin).send({ status: 'approved' }), 200);
  const performed = await step('realizar procedimento', api().post(`/api/budgets/${budget.id}/items/${itemA.id}/perform`).set(admin), 200);
  expect(performed.items[0].performedByDentistId).toBe(dentist.id);
  const done = await step('cancelar item', api().post(`/api/budgets/${budget.id}/items/${itemB.id}/cancel`).set(admin), 200);
  expect(done.status).toBe('completed');
  const odontogram = await step('odontograma marcado pelo procedimento', api().get(`/api/patients/${patient.id}/odontogram`).set(admin), 200);
  expect(odontogram.teeth['16'][0]).toMatchObject({ condition: 'restoration', faces: 'DO' });

  // ---- pagamentos (total do orçamento: 20.000 - 1.000 = 19.000) ----
  await step('lançar parcela', api().post(`/api/budgets/${budget.id}/payments`).set(admin).send({ amountCents: 5000, dueDate: '2099-03-10' }), 201);
  const plan = await step('gerar parcelas', api().post(`/api/budgets/${budget.id}/payment-plan`).set(admin).send({ installments: 2, firstDueDate: '2099-04-10' }), 201);
  expect(plan.map((p) => p.amountCents)).toEqual([7000, 7000]);
  const financial = await step('pagamentos do orçamento', api().get(`/api/budgets/${budget.id}/payments`).set(admin), 200);
  expect(financial.summary).toMatchObject({ totalCents: 19000, scheduledCents: 19000, balanceCents: 0 });
  await step('contas a receber', api().get('/api/payments').set(admin), 200);
  await step('consultar pagamento', api().get(`/api/payments/${plan[0].id}`).set(admin), 200);
  await step('alterar pagamento', api().patch(`/api/payments/${plan[0].id}`).set(admin).send({ notes: 'Combinado por telefone' }), 200);
  await step('receber', api().post(`/api/payments/${plan[0].id}/pay`).set(admin).send({ method: 'pix' }), 200);
  await step('cancelar parcela', api().post(`/api/payments/${plan[1].id}/cancel`).set(admin).send({ reason: 'Paciente quitou em dinheiro' }), 200);

  // ---- repasse ao dentista ----
  await step('configurar repasse', api().patch('/api/payouts/settings').set(admin).send({ releaseOn: 'procedure', deductCosts: true, defaultPercent: 30 }), 200);
  await step('ver configuração', api().get('/api/payouts/settings').set(admin), 200);
  const exception = await step('criar regra', api().post('/api/payouts/rules').set(admin).send({ procedureId: procedure.id, dentistId: dentist.id, type: 'percent', percent: 50 }), 201);
  await step('alterar regra', api().patch(`/api/payouts/rules/${exception.id}`).set(admin).send({ type: 'fixed', fixedCents: 2500 }), 200);
  await step('listar regras', api().get('/api/payouts/rules').set(admin), 200);
  const applied = await step('qual regra vale', api().get(`/api/payouts/rules/resolve?dentistId=${dentist.id}&procedureId=${procedure.id}`).set(admin), 200);
  expect(applied).toMatchObject({ source: 'dentist_procedure', type: 'fixed', fixedCents: 2500 });
  await step('remover regra', api().delete(`/api/payouts/rules/${exception.id}`).set(admin), 204);
  // o procedimento realizado antes da configuração gerou lançamento com a regra do dentista (40%) sobre R$ 194,29:
  // R$ 200,00 menos a parte do desconto (R$ 10,00 de um orçamento de R$ 350,00)
  const lines = await step('lançamentos', api().get('/api/payouts/entries').set(admin), 200);
  expect(lines.data).toHaveLength(1);
  expect(lines.data[0]).toMatchObject({ rule: { source: 'dentist', percent: 40 }, commissionCents: 7772 });
  await step('saldos', api().get('/api/payouts/balances').set(admin), 200);
  const payout = await step('pagar repasse', api().post('/api/payouts').set(admin).send({ dentistId: dentist.id, method: 'pix', notes: 'Fechamento' }), 201);
  expect(payout.totalCents).toBe(lines.data[0].releasedCents);
  await step('listar fechamentos', api().get('/api/payouts').set(admin), 200);
  await step('consultar fechamento', api().get(`/api/payouts/${payout.id}`).set(admin), 200);
  await step('desfazer fechamento', api().post(`/api/payouts/${payout.id}/cancel`).set(admin).send({ reason: 'Teste' }), 200);

  // ---- relatórios gerenciais ----
  const report = await step('relatório do mês', api().get('/api/reports/monthly').set(admin), 200);
  expect(report.production.proceduresCount).toBe(1);
  expect(report.dentists[0].dentist.id).toBe(dentist.id);
  const trend = await step('evolução', api().get('/api/reports/trend?months=3').set(admin), 200);
  expect(trend.data).toHaveLength(3);

  // ---- nenhuma rota ficou de fora ----
  const missing = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).flatMap(([method, operation]) => {
      const success = Object.keys(operation.responses).find((status) => status.startsWith('2'));
      return validated.has(`${method.toUpperCase()} ${path} ${success}`) ? [] : [`${method.toUpperCase()} ${path} (${success})`];
    }));
  expect(missing, 'rotas cujo sucesso não foi exercitado pela jornada').toEqual([]);
}, 120_000);
