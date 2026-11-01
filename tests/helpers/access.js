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

export const ACCESS = {
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
  'POST /api/patients': { access: ANY, noRefs: true, body: () => ({ name: 'Paciente Novo' }) },
  'PATCH /api/patients/:id': { access: ANY, params: { id: 'patient' }, body: () => ({ notes: 'obs' }) },
  'GET /api/patients/:patientId/odontogram': { access: ANY, params: { patientId: 'patient' } },
  'POST /api/patients/:patientId/odontogram': { access: CLINICAL, params: { patientId: 'patient' }, body: () => ({ tooth: 12, condition: 'caries' }) },
  'DELETE /api/patients/:patientId/odontogram/:recordId': { access: CLINICAL, params: { patientId: 'patient', recordId: 'record' } },
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
  'POST /api/budgets/:id/items': { access: CLINICAL, params: { id: 'budget' }, scoped: 'resource', body: (f) => ({ procedureId: f.procedure.id }) },
  'PATCH /api/budgets/:id/items/:itemId': { access: CLINICAL, params: { id: 'budget', itemId: 'item' }, scoped: 'resource', body: () => ({ priceCents: 1 }) },
  'DELETE /api/budgets/:id/items/:itemId': { access: CLINICAL, params: { id: 'budget', itemId: 'item' }, scoped: 'resource' },
  'POST /api/budgets/:id/items/:itemId/perform': { access: CLINICAL, params: { id: 'budget', itemId: 'item' }, scoped: 'resource', body: () => ({}) },
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
  // ---- plataforma ----
  'POST /api/platform/login': { access: 'public' },
  'GET /api/platform/clinics': { access: 'platform', noRefs: true },
  'POST /api/platform/clinics': {
    access: 'platform', noRefs: true,
    body: (f) => ({ name: `Clínica nova ${f.label}`, admin: { name: 'Admin Novo', email: `admin.novo.${f.label}@seg.test`, password: 'senha-segura-123' } }),
  },
  'GET /api/platform/clinics/:id': { access: 'platform', params: { id: 'clinic' } },
  'PATCH /api/platform/clinics/:id': { access: 'platform', params: { id: 'clinic' }, body: () => ({ plan: 'premium' }) },
};

export const RESOURCE = {
  target: (f) => f.target.id, dentist: (f) => f.d1.dentist.id, procedure: (f) => f.procedure.id, patient: (f) => f.patient.id,
  budget: (f) => f.budget.id, item: (f) => f.item.id, appointment: (f) => f.appointment.id, payment: (f) => f.payment.id,
  record: (f) => f.record.id, clinic: (f) => f.clinic.id,
};

