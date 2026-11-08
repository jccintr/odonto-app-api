import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/auth.js';
import { z } from '../../config/zod.js';
import { uuidField } from '../../utils/fields.js';
import { listTreatmentItems } from './treatment.service.js';

// Montado em /api/patients/:id. Qualquer perfil da clínica consulta; o dentista vê os itens de todos os colegas.
const router = Router({ mergeParams: true });

router.get('/treatment-items', authenticate, validate({ params: z.object({ id: uuidField }) }), async (req, res) => {
  res.json(await listTreatmentItems(req.auth.clinicId, req.valid.params.id));
});

export default router;
