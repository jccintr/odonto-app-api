import { Router } from 'express';
import { z } from '../../config/zod.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import * as service from './account.service.js';

const router = Router();
const deletionSchema = z.object({ password: z.string().min(1, 'Informe a senha.') });

router.use(authenticate, requireRole('admin'));
router.get('/export', async (req, res) => res.json(await service.exportData(req.auth.clinicId)));
router.post('/deletion-request', validate({ body: deletionSchema }), async (req, res) => {
  res.json(await service.requestDeletion(req.auth.clinicId, req.auth.user, req.valid.body.password));
});
router.delete('/deletion-request', async (req, res) => res.json(await service.cancelDeletion(req.auth.clinicId, req.auth.userId)));

export default router;
