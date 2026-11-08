import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { getStanding, releaseBlock } from './standing.service.js';
import { releaseSchema, standingParams } from './standing.schemas.js';

// Montado em /api/patients/:id (antes do router de pacientes). Situação financeira é da administração; só o admin libera.
const router = Router({ mergeParams: true });

router.get('/standing', authenticate, requireRole('admin', 'secretary'), validate({ params: standingParams }), async (req, res) => {
  res.json(await getStanding(req.auth.clinicId, req.valid.params.id));
});
router.post('/block-release', authenticate, requireRole('admin'), validate({ params: standingParams, body: releaseSchema }), async (req, res) => {
  res.status(201).json(await releaseBlock(req.auth, req.valid.params.id, req.valid.body));
});

export default router;
