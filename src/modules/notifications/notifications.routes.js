import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { runReminders } from './notifications.reminders.js';
import { appointmentWhatsapp, budgetWhatsapp, listNotifications, sendBudgetNow, sendReminderNow } from './notifications.service.js';
import { getSettings, updateSettings } from './notifications.settings.js';
import { appointmentParams, budgetParams, listNotificationsQuery, updateSettingsSchema } from './notifications.schemas.js';

const router = Router();

// Comunicação com o paciente é com a administração e a secretária; só o administrador muda a configuração.
router.use(authenticate);
const staff = requireRole('admin', 'secretary');

router.get('/settings', staff, async (req, res) => res.json(await getSettings(req.auth.clinicId)));
router.patch('/settings', requireRole('admin'), validate({ body: updateSettingsSchema }), async (req, res) => {
  res.json(await updateSettings(req.auth, req.valid.body));
});

router.get('/', staff, validate({ query: listNotificationsQuery }), async (req, res) => {
  res.json(await listNotifications(req.auth.clinicId, req.valid.query));
});

// roda agora os lembretes desta clínica (o agendador faz isso sozinho, de todas as clínicas)
router.post('/reminders/run', requireRole('admin'), async (req, res) => {
  res.json(await runReminders({ clinicId: req.auth.clinicId }));
});

router.post('/appointments/:appointmentId/reminder', staff, validate({ params: appointmentParams }), async (req, res) => {
  res.status(201).json(await sendReminderNow(req.auth, req.valid.params.appointmentId));
});
router.get('/appointments/:appointmentId/whatsapp', staff, validate({ params: appointmentParams }), async (req, res) => {
  res.json(await appointmentWhatsapp(req.auth.clinicId, req.valid.params.appointmentId));
});
router.post('/budgets/:budgetId/email', staff, validate({ params: budgetParams }), async (req, res) => {
  res.status(201).json(await sendBudgetNow(req.auth, req.valid.params.budgetId));
});
router.get('/budgets/:budgetId/whatsapp', staff, validate({ params: budgetParams }), async (req, res) => {
  res.json(await budgetWhatsapp(req.auth.clinicId, req.valid.params.budgetId));
});

export default router;
