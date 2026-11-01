import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { idParams } from '../../utils/fields.js';
import { createPayment, listBudgetPayments, planPayments } from './payments.service.js';
import { createPaymentSchema, planSchema } from './payments.schemas.js';

// Montado em /api/budgets/:id (antes do router de orçamentos). A autenticação é por rota para não pesar nas demais.
const router = Router({ mergeParams: true });
const finance = [authenticate, requireRole('admin', 'secretary')];

router.get('/payments', ...finance, validate({ params: idParams }), async (req, res) => {
  res.json(await listBudgetPayments(req.auth, req.valid.params.id));
});
router.post('/payments', ...finance, validate({ params: idParams, body: createPaymentSchema }), async (req, res) => {
  res.status(201).json(await createPayment(req.auth, req.valid.params.id, req.valid.body));
});
router.post('/payment-plan', ...finance, validate({ params: idParams, body: planSchema }), async (req, res) => {
  res.status(201).json(await planPayments(req.auth, req.valid.params.id, req.valid.body));
});

export default router;
