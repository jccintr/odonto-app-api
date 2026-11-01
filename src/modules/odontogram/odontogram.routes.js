import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { addRecord, getOdontogram, removeRecord } from './odontogram.service.js';
import { createRecordSchema, patientParams, recordParams } from './odontogram.schemas.js';

// Montado em /api/patients/:patientId/odontogram
const router = Router({ mergeParams: true });

// Todos consultam (a secretária imprime a ficha com odontograma); só admin e dentista marcam ou removem.
router.use(authenticate);
router.get('/', validate({ params: patientParams }), async (req, res) => {
  res.json(await getOdontogram(req.auth, req.valid.params.patientId));
});
router.post('/', requireRole('admin', 'dentist'), validate({ params: patientParams, body: createRecordSchema }), async (req, res) => {
  res.status(201).json(await addRecord(req.auth, req.valid.params.patientId, req.valid.body));
});
router.delete('/:recordId', requireRole('admin', 'dentist'), validate({ params: recordParams }), async (req, res) => {
  await removeRecord(req.auth, req.valid.params.patientId, req.valid.params.recordId);
  res.status(204).end();
});

export default router;
