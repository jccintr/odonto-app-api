import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { idParams } from '../../utils/fields.js';
import { createProcedure, getProcedure, listProcedures, updateProcedure } from './procedures.service.js';
import { createProcedureSchema, listProceduresQuery, updateProcedureSchema } from './procedures.schemas.js';

const router = Router();

// Tabela de procedimentos e preços: todos consultam, só o administrador altera.
router.use(authenticate);
router.get('/', validate({ query: listProceduresQuery }), async (req, res) => {
  res.json(await listProcedures(req.auth.clinicId, req.valid.query));
});
router.get('/:id', validate({ params: idParams }), async (req, res) => {
  res.json(await getProcedure(req.auth.clinicId, req.valid.params.id));
});
router.post('/', requireRole('admin'), validate({ body: createProcedureSchema }), async (req, res) => {
  res.status(201).json(await createProcedure(req.auth.clinicId, req.valid.body));
});
router.patch('/:id', requireRole('admin'), validate({ params: idParams, body: updateProcedureSchema }), async (req, res) => {
  res.json(await updateProcedure(req.auth.clinicId, req.valid.params.id, req.valid.body));
});

export default router;
