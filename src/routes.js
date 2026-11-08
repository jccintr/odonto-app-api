import { Router } from 'express';
import accountRoutes from './modules/account/account.routes.js';
import appointmentsRoutes from './modules/appointments/appointments.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import clinicRoutes from './modules/clinic/clinic.routes.js';
import dentistsRoutes from './modules/dentists/dentists.routes.js';
import evolutionsRoutes from './modules/evolutions/evolutions.routes.js';
import imagesRoutes from './modules/images/images.routes.js';
import legalRoutes from './modules/legal/legal.routes.js';
import notificationsRoutes from './modules/notifications/notifications.routes.js';
import odontogramRoutes from './modules/odontogram/odontogram.routes.js';
import patientsRoutes from './modules/patients/patients.routes.js';
import budgetPaymentsRoutes from './modules/payments/budgetPayments.routes.js';
import paymentsRoutes from './modules/payments/payments.routes.js';
import payoutsRoutes from './modules/payouts/payouts.routes.js';
import reportsRoutes from './modules/reports/reports.routes.js';
import platformRoutes from './modules/platform/platform.routes.js';
import proceduresRoutes from './modules/procedures/procedures.routes.js';
import billingRoutes from './modules/billing/billing.routes.js';
import budgetsRoutes from './modules/budgets/budgets.routes.js';
import treatmentRoutes from './modules/budgets/treatment.routes.js';
import worklistRoutes from './modules/worklist/worklist.routes.js';
import standingRoutes from './modules/standing/standing.routes.js';
import signupRoutes from './modules/signup/signup.routes.js';
import usersRoutes from './modules/users/users.routes.js';

const router = Router();

// Tabela de montagem das rotas. É exportada para o teste de segurança (tests/security.matrix.test.js) descobrir todas as rotas
// automaticamente: rota nova sem regra de acesso declarada lá faz o teste falhar. A ordem importa (mais específicas primeiro).
export const MOUNTS = [
  ['/auth', authRoutes],
  ['/signup', signupRoutes],
  ['/legal', legalRoutes],
  ['/billing', billingRoutes],
  ['/account', accountRoutes],
  ['/clinic', clinicRoutes],
  ['/users', usersRoutes],
  ['/dentists', dentistsRoutes],
  ['/patients/:patientId/odontogram', odontogramRoutes],
  ['/patients/:patientId/images', imagesRoutes],
  ['/patients/:patientId/evolutions', evolutionsRoutes],
  ['/worklist', worklistRoutes],
  ['/patients/:id', standingRoutes],
  ['/patients/:id', treatmentRoutes],
  ['/patients', patientsRoutes],
  ['/procedures', proceduresRoutes],
  ['/appointments', appointmentsRoutes],
  ['/budgets/:id', budgetPaymentsRoutes],
  ['/budgets', budgetsRoutes],
  ['/payments', paymentsRoutes],
  ['/notifications', notificationsRoutes],
  ['/payouts', payoutsRoutes],
  ['/reports', reportsRoutes],
  ['/platform', platformRoutes],
];

for (const [prefix, routes] of MOUNTS) router.use(prefix, routes);

export default router;
