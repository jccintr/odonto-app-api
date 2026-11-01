import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { idParams } from '../../utils/fields.js';
import { getDentist, listDentists, updateDentist } from './dentists.service.js';
import { listDentistsQuery, updateDentistSchema } from './dentists.schemas.js';

const router = Router();

// Os dentistas nascem junto com o usuário de perfil "dentist" (POST /api/users). Aqui ficam os dados profissionais.
router.use(authenticate);
router.get('/', validate({ query: listDentistsQuery }), async (req, res) => {
  res.json(await listDentists(req.auth.clinicId, req.valid.query));
});
router.get('/:id', validate({ params: idParams }), async (req, res) => {
  res.json(await getDentist(req.auth.clinicId, req.valid.params.id));
});
router.patch('/:id', requireRole('admin'), validate({ params: idParams, body: updateDentistSchema }), async (req, res) => {
  res.json(await updateDentist(req.auth.clinicId, req.valid.params.id, req.valid.body));
});

export default router;
