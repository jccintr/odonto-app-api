// Regras de acesso esperadas, por rota, usadas pelos testes de segurança e de documentação.
// access: 'public' | 'platform' | lista de perfis da clínica que PODEM chamar.
// params: parâmetro da URL -> recurso do fixture. body: monta um corpo VÁLIDO (para o 404/403 vir antes de qualquer 400).
// scoped: 'resource' (dentista só alcança os próprios: 404 no alheio) | 'create' (informa dentistId: 403 se for de outro).
// noRefs: a rota não recebe id de recurso, então não há "id de outra clínica" para tentar.
export const ANY = ['admin', 'secretary', 'dentist'];
export const ROLES = ANY;
export const CLINICAL = ['admin', 'dentist'];
export const FINANCE = ['admin', 'secretary'];
export const ADMIN = ['admin'];
export const STAFF = ['admin', 'secretary']; // administração e secretária

export const ACCESS = {
  // ---- cadastro público e textos legais ----
  'GET /api/signup/options': { access: 'public' },
  'POST /api/signup': { access: 'public' },
  'GET /api/legal/:type': { access: 'public' },
  // ---- assinatura da clínica (cobrança por Pix) ----
  'GET /api/billing/status': { access: ANY, noRefs: true },
  'GET /api/billing': { access: ADMIN, noRefs: true },
  'POST /api/billing/plan': { access: ADMIN, noRefs: true, body: (f) => ({ planId: f.plan.id }) },
  'POST /api/billing/invoices/:id/reported': { access: ADMIN, params: { id: 'invoice' }, body: () => ({}) },
  // ---- conta (LGPD) ----
  'GET /api/account/export': { access: ADMIN, noRefs: true },
  'POST /api/account/deletion-request': { access: ADMIN, noRefs: true, body: () => ({ password: 'senha-errada-1' }) },
  'DELETE /api/account/deletion-request': { access: ADMIN, noRefs: true },
  // ---- autenticação ----
  'POST /api/auth/login': { access: 'public' },
  'POST /api/auth/refresh': { access: 'public' },
  'POST /api/auth/logout': { access: 'public' },
  'POST /api/auth/verify-email': { access: 'public' },
  'POST /api/auth/resend-verification': { access: 'public' },
  'POST /api/auth/forgot-password': { access: 'public' },
  'POST /api/auth/reset-password': { access: 'public' },
  'GET /api/auth/me': { access: ANY, noRefs: true },
  'POST /api/auth/change-password': { access: ANY, noRefs: true, body: () => ({ currentPassword: 'senha-errada-1', newPassword: 'nova-senha-123' }) },
  // ---- clínica e usuários ----
  'GET /api/clinic': { access: ANY, noRefs: true },
  'GET /api/clinic/onboarding': { access: ADMIN, noRefs: true },
  'POST /api/clinic/onboarding/prices-reviewed': { access: ADMIN, noRefs: true, body: () => ({}) },
  'PATCH /api/clinic': { access: ADMIN, noRefs: true, body: () => ({ name: 'Clínica Renomeada' }) },
  'GET /api/users': { access: ADMIN, noRefs: true },
  'POST /api/users': { access: ADMIN, noRefs: true, body: (f) => ({ name: 'Novo Usuário', email: `novo.${f.label}@seg.test`, password: 'senha-segura-123', role: 'secretary' }) },
  'GET /api/users/:id': { access: ADMIN, params: { id: 'target' } },
  'PATCH /api/users/:id': { access: ADMIN, params: { id: 'target' }, body: () => ({ name: 'Nome Alterado' }) },
  // ---- dentistas e procedimentos ----
  'GET /api/dentists': { access: ANY, noRefs: true },
  'GET /api/dentists/:id': { access: ANY, params: { id: 'dentist' } },
  'PATCH /api/dentists/:id': { access: ADMIN, params: { id: 'dentist' }, body: () => ({ specialty: 'Ortodontia' }) },
  'GET /api/procedures': { access: ANY, noRefs: true },
  'GET /api/procedures/:id': { access: ANY, params: { id: 'procedure' } },
  'POST /api/procedures': { access: ADMIN, noRefs: true, body: (f) => ({ name: `Novo procedimento ${f.label}` }) },
  'PATCH /api/procedures/:id': { access: ADMIN, params: { id: 'procedure' }, body: () => ({ priceCents: 1 }) },
  // ---- pacientes e odontograma ----
  'GET /api/patients': { access: ANY, noRefs: true },
  'GET /api/patients/:id': { access: ANY, params: { id: 'patient' } },
  'GET /api/worklist': { access: FINANCE, noRefs: true },
  'GET /api/patients/:id/treatment-items': { access: ANY, params: { id: 'patient' } },
  'GET /api/patients/:id/standing': { access: FINANCE, params: { id: 'patient' } },
  'POST /api/patients/:id/block-release': { access: ADMIN, params: { id: 'patient' }, body: () => ({ reason: 'Urgência', days: 1 }) },
  'POST /api/patients': { access: ANY, noRefs: true, body: () => ({ name: 'Paciente Novo' }) },
  'PATCH /api/patients/:id': { access: ANY, params: { id: 'patient' }, body: () => ({ notes: 'obs' }) },
  'GET /api/patients/:patientId/odontogram': { access: ANY, params: { patientId: 'patient' } },
  'POST /api/patients/:patientId/odontogram': { access: CLINICAL, params: { patientId: 'patient' }, body: () => ({ tooth: 12, condition: 'caries' }) },
  'DELETE /api/patients/:patientId/odontogram/:recordId': { access: CLINICAL, params: { patientId: 'patient', recordId: 'record' } },
  'GET /api/patients/:patientId/images': { access: ANY, params: { patientId: 'patient' } },
  'POST /api/patients/:patientId/images/upload-signature': { access: CLINICAL, params: { patientId: 'patient' }, body: () => ({}) },
  'POST /api/patients/:patientId/images': { access: CLINICAL, params: { patientId: 'patient' }, body: () => ({ publicId: 'arquivo-que-nao-existe', kind: 'xray' }) },
  'GET /api/patients/:patientId/images/:imageId': { access: ANY, params: { patientId: 'patient', imageId: 'image' } },
  'PATCH /api/patients/:patientId/images/:imageId': { access: CLINICAL, params: { patientId: 'patient', imageId: 'image' }, body: () => ({ notes: 'obs' }) },
  'DELETE /api/patients/:patientId/images/:imageId': { access: CLINICAL, params: { patientId: 'patient', imageId: 'image' } },
  'GET /api/patients/:patientId/evolutions': { access: CLINICAL, params: { patientId: 'patient' } },
  'POST /api/patients/:patientId/evolutions/:id/addendum': { access: ['dentist'], params: { patientId: 'patient', id: 'evolution' }, body: () => ({ description: 'Retificação de teste' }) },
  // ---- agenda ----
  'GET /api/appointments': { access: ANY, noRefs: true },
  'GET /api/appointments/:id': { access: ANY, params: { id: 'appointment' }, scoped: 'resource' },
  'POST /api/appointments': {
    access: ANY, scoped: 'create',
    body: (f) => ({ patientId: f.patient.id, dentistId: f.d1.dentist.id, startsAt: '2099-02-01T10:00:00.000Z', endsAt: '2099-02-01T11:00:00.000Z' }),
  },
  'PATCH /api/appointments/:id': { access: ANY, params: { id: 'appointment' }, scoped: 'resource', body: () => ({ notes: 'obs' }) },
  'POST /api/appointments/:id/status': { access: ANY, params: { id: 'appointment' }, scoped: 'resource', body: () => ({ status: 'confirmed' }) },
  // ---- orçamentos ----
  'GET /api/budgets': { access: ANY, noRefs: true },
  'GET /api/budgets/:id': { access: ANY, params: { id: 'budget' }, scoped: 'resource' },
  'POST /api/budgets': {
    access: CLINICAL, scoped: 'create',
    body: (f) => ({ patientId: f.patient.id, dentistId: f.d1.dentist.id, items: [{ procedureId: f.procedure.id }] }),
  },
  'PATCH /api/budgets/:id': { access: CLINICAL, params: { id: 'budget' }, scoped: 'resource', body: () => ({ notes: 'obs' }) },
  'POST /api/budgets/:id/status': { access: ANY, params: { id: 'budget' }, scoped: 'resource', body: () => ({ status: 'approved' }) },
  'POST /api/budgets/:id/approvals': { access: ANY, params: { id: 'budget' }, scoped: 'resource', body: (f) => ({ itemIds: [f.item.id], discountCents: 0 }) },
  'POST /api/budgets/:id/items': { access: CLINICAL, params: { id: 'budget' }, scoped: 'resource', body: (f) => ({ procedureId: f.procedure.id }) },
  'PATCH /api/budgets/:id/items/:itemId': { access: CLINICAL, params: { id: 'budget', itemId: 'item' }, scoped: 'resource', body: () => ({ tooth: 11 }) },
  'DELETE /api/budgets/:id/items/:itemId': { access: CLINICAL, params: { id: 'budget', itemId: 'item' }, scoped: 'resource' },
  'POST /api/budgets/:id/items/:itemId/cancel': { access: CLINICAL, params: { id: 'budget', itemId: 'item' }, scoped: 'resource' },
  // ---- financeiro ----
  'GET /api/budgets/:id/payments': { access: FINANCE, params: { id: 'budget' } },
  'POST /api/budgets/:id/payments': { access: FINANCE, params: { id: 'budget' }, body: () => ({ amountCents: 100, dueDate: '2099-01-01' }) },
  'POST /api/budgets/:id/payment-plan': { access: FINANCE, params: { id: 'budget' }, body: () => ({ installments: 1, firstDueDate: '2099-01-01' }) },
  'GET /api/payments': { access: FINANCE, noRefs: true },
  'GET /api/payments/:id': { access: FINANCE, params: { id: 'payment' } },
  'PATCH /api/payments/:id': { access: FINANCE, params: { id: 'payment' }, body: () => ({ notes: 'obs' }) },
  'POST /api/payments/:id/pay': { access: FINANCE, params: { id: 'payment' }, body: () => ({ method: 'cash' }) },
  'POST /api/payments/:id/cancel': { access: FINANCE, params: { id: 'payment' }, body: () => ({}) },
  // ---- repasse (só administração) ----
  'GET /api/payouts/settings': { access: ADMIN, noRefs: true },
  'PATCH /api/payouts/settings': { access: ADMIN, noRefs: true, body: () => ({ defaultPercent: 25 }) },
  'GET /api/payouts/rules': { access: ADMIN, noRefs: true },
  'GET /api/payouts/rules/resolve': { access: ADMIN, query: (f) => `?dentistId=${f.d1.dentist.id}&procedureId=${f.procedure.id}` },
  'POST /api/payouts/rules': { access: ADMIN, body: (f) => ({ procedureId: f.procedure.id, dentistId: f.d1.dentist.id, type: 'percent', percent: 50 }) },
  'PATCH /api/payouts/rules/:id': { access: ADMIN, params: { id: 'rule' }, body: () => ({ type: 'fixed', fixedCents: 1000 }) },
  'DELETE /api/payouts/rules/:id': { access: ADMIN, params: { id: 'rule' } },
  'GET /api/payouts/entries': { access: ADMIN, noRefs: true },
  'GET /api/payouts/balances': { access: ADMIN, noRefs: true },
  'GET /api/payouts': { access: ADMIN, noRefs: true },
  'POST /api/payouts': { access: ADMIN, body: (f) => ({ dentistId: f.d1.dentist.id, method: 'pix' }) },
  'GET /api/payouts/:id': { access: ADMIN, params: { id: 'payout' } },
  'POST /api/payouts/:id/cancel': { access: ADMIN, params: { id: 'payout' }, body: () => ({}) },
  // ---- avisos ao paciente ----
  'GET /api/notifications/settings': { access: STAFF, noRefs: true },
  'PATCH /api/notifications/settings': { access: ADMIN, noRefs: true, body: () => ({ reminderHoursBefore: 12 }) },
  'GET /api/notifications': { access: STAFF, noRefs: true },
  'POST /api/notifications/reminders/run': { access: ADMIN, noRefs: true, body: () => ({}) },
  'POST /api/notifications/appointments/:appointmentId/reminder': { access: STAFF, params: { appointmentId: 'appointment' }, body: () => ({}) },
  'GET /api/notifications/appointments/:appointmentId/whatsapp': { access: STAFF, params: { appointmentId: 'appointment' } },
  'POST /api/notifications/budgets/:budgetId/email': { access: STAFF, params: { budgetId: 'budget' }, body: () => ({}) },
  'GET /api/notifications/budgets/:budgetId/whatsapp': { access: STAFF, params: { budgetId: 'budget' } },
  // ---- relatórios (só administração) ----
  'GET /api/reports/monthly': { access: ADMIN, noRefs: true },
  'GET /api/reports/trend': { access: ADMIN, noRefs: true },
  // ---- plataforma ----
  'POST /api/platform/login': { access: 'public' },
  'GET /api/platform/overview': { access: 'platform', noRefs: true },
  'GET /api/platform/clinics': { access: 'platform', noRefs: true },
  'POST /api/platform/clinics': {
    access: 'platform', noRefs: true,
    body: (f) => ({ name: `Clínica nova ${f.label}`, admin: { name: 'Admin Novo', email: `admin.novo.${f.label}@seg.test`, password: 'senha-segura-123' } }),
  },
  'GET /api/platform/clinics/:id': { access: 'platform', params: { id: 'clinic' } },
  'PATCH /api/platform/clinics/:id': { access: 'platform', params: { id: 'clinic' }, body: () => ({ plan: 'premium' }) },
  'GET /api/platform/clinics/:id/billing': { access: 'platform', params: { id: 'clinic' } },
  'POST /api/platform/clinics/:id/invoices/:invoiceId/pay': { access: 'platform', params: { id: 'clinic', invoiceId: 'invoice' }, body: () => ({}) },
  'POST /api/platform/clinics/:id/trial/extend': { access: 'platform', params: { id: 'clinic' }, body: () => ({ days: 7 }) },
  'PUT /api/platform/clinics/:id/courtesy': { access: 'platform', params: { id: 'clinic' }, body: () => ({ indefinite: false, until: null }) },
  'GET /api/platform/invoices': { access: 'platform', noRefs: true },
  'GET /api/platform/plans': { access: 'platform', noRefs: true },
  'PATCH /api/platform/plans/:id': { access: 'platform', params: { id: 'plan' }, body: () => ({ description: 'Plano ajustado' }) },
};

export const RESOURCE = {
  target: (f) => f.target.id, dentist: (f) => f.d1.dentist.id, procedure: (f) => f.procedure.id, patient: (f) => f.patient.id,
  budget: (f) => f.budget.id, item: (f) => f.item.id, appointment: (f) => f.appointment.id, payment: (f) => f.payment.id,
  record: (f) => f.record.id, evolution: (f) => f.evolution.id, clinic: (f) => f.clinic.id, rule: (f) => f.rule.id, image: (f) => f.image.id, payout: (f) => f.payout.id, invoice: (f) => f.invoice.id, plan: (f) => f.plan.id,
};

