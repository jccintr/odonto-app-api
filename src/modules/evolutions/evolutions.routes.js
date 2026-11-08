import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { addAddendum, listEvolutions } from './evolutions.service.js';
import { addendumSchema, evolutionParams, listEvolutionsQuery, patientParams } from './evolutions.schemas.js';

// Montado em /api/patients/:patientId/evolutions. O prontuário é clínico: a secretária não lê.
// A evolução nasce ao marcar o atendimento como atendido (POST /api/appointments/:id/status); aqui só se consulta e se retifica.
const router = Router({ mergeParams: true });

router.use(authenticate);
router.get('/', requireRole('admin', 'dentist'), validate({ params: patientParams, query: listEvolutionsQuery }), async (req, res) => {
  res.json(await listEvolutions(req.auth, req.valid.params.patientId, req.valid.query));
});
router.post('/:id/addendum', requireRole('dentist'), validate({ params: evolutionParams, body: addendumSchema }), async (req, res) => {
  res.status(201).json(await addAddendum(req.auth, req.valid.params.patientId, req.valid.params.id, req.valid.body));
});

export default router;
