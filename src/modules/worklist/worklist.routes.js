import { Router } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { getWorklist } from './worklist.service.js';

const router = Router();

// O que a recepção precisa resolver hoje: envolve valores, então é da administração e da secretária.
router.get('/', authenticate, requireRole('admin', 'secretary'), async (req, res) => {
  res.json(await getWorklist(req.auth.clinicId));
});

export default router;
