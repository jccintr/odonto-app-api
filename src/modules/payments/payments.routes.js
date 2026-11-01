import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { idParams } from '../../utils/fields.js';
import { cancelPayment, getPayment, listPayments, payPayment, updatePayment } from './payments.service.js';
import { cancelSchema, listPaymentsQuery, paySchema, updatePaymentSchema } from './payments.schemas.js';

const router = Router();

// Financeiro da clínica: só administração e secretária (o dentista não vê o caixa).
router.use(authenticate, requireRole('admin', 'secretary'));

router.get('/', validate({ query: listPaymentsQuery }), async (req, res) => {
  res.json(await listPayments(req.auth.clinicId, req.valid.query));
});
router.get('/:id', validate({ params: idParams }), async (req, res) => {
  res.json(await getPayment(req.auth.clinicId, req.valid.params.id));
});
router.patch('/:id', validate({ params: idParams, body: updatePaymentSchema }), async (req, res) => {
  res.json(await updatePayment(req.auth, req.valid.params.id, req.valid.body));
});
router.post('/:id/pay', validate({ params: idParams, body: paySchema }), async (req, res) => {
  res.json(await payPayment(req.auth, req.valid.params.id, req.valid.body));
});
router.post('/:id/cancel', validate({ params: idParams, body: cancelSchema }), async (req, res) => {
  res.json(await cancelPayment(req.auth, req.valid.params.id, req.valid.body));
});

export default router;
