import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { getClinic, updateClinic } from './clinic.service.js';
import { updateClinicSchema } from './clinic.schemas.js';

const router = Router();

router.use(authenticate);
router.get('/', async (req, res) => res.json(await getClinic(req.auth.clinicId)));
router.patch('/', requireRole('admin'), validate({ body: updateClinicSchema }), async (req, res) => {
  res.json(await updateClinic(req.auth.clinicId, req.valid.body));
});

export default router;
