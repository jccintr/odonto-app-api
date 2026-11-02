import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import * as service from './billing.service.js';
import { choosePlanSchema, idParams, reportPaidSchema } from './billing.schemas.js';

const router = Router();

router.use(authenticate);
router.get('/status', async (req, res) => res.json(await service.getStatus(req.auth.clinicId)));

router.use(requireRole('admin'));
router.get('/', async (req, res) => res.json(await service.getBilling(req.auth.clinicId)));
router.post('/plan', validate({ body: choosePlanSchema }), async (req, res) => {
  res.json(await service.choosePlan(req.auth.clinicId, req.auth.userId, req.valid.body.planId));
});
router.post('/invoices/:id/reported', validate({ params: idParams, body: reportPaidSchema }), async (req, res) => {
  res.json(await service.reportPaid(req.auth.clinicId, req.auth.userId, req.valid.params.id, req.valid.body.note));
});

export default router;
