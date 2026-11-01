import { Router } from 'express';
import appointmentsRoutes from './modules/appointments/appointments.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import clinicRoutes from './modules/clinic/clinic.routes.js';
import dentistsRoutes from './modules/dentists/dentists.routes.js';
import odontogramRoutes from './modules/odontogram/odontogram.routes.js';
import patientsRoutes from './modules/patients/patients.routes.js';
import budgetPaymentsRoutes from './modules/payments/budgetPayments.routes.js';
import paymentsRoutes from './modules/payments/payments.routes.js';
import payoutsRoutes from './modules/payouts/payouts.routes.js';
import reportsRoutes from './modules/reports/reports.routes.js';
import platformRoutes from './modules/platform/platform.routes.js';
import proceduresRoutes from './modules/procedures/procedures.routes.js';
import budgetsRoutes from './modules/budgets/budgets.routes.js';
import usersRoutes from './modules/users/users.routes.js';

const router = Router();

// Tabela de montagem das rotas. É exportada para o teste de segurança (tests/security.matrix.test.js) descobrir todas as rotas
// automaticamente: rota nova sem regra de acesso declarada lá faz o teste falhar. A ordem importa (mais específicas primeiro).
export const MOUNTS = [
  ['/auth', authRoutes],
  ['/clinic', clinicRoutes],
  ['/users', usersRoutes],
  ['/dentists', dentistsRoutes],
  ['/patients/:patientId/odontogram', odontogramRoutes],
  ['/patients', patientsRoutes],
  ['/procedures', proceduresRoutes],
  ['/appointments', appointmentsRoutes],
  ['/budgets/:id', budgetPaymentsRoutes],
  ['/budgets', budgetsRoutes],
  ['/payments', paymentsRoutes],
  ['/payouts', payoutsRoutes],
  ['/reports', reportsRoutes],
  ['/platform', platformRoutes],
];

for (const [prefix, routes] of MOUNTS) router.use(prefix, routes);

export default router;
