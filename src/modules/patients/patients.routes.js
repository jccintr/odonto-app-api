import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/auth.js';
import { idParams } from '../../utils/fields.js';
import { createPatient, getPatient, listPatients, updatePatient } from './patients.service.js';
import { createPatientSchema, listPatientsQuery, updatePatientSchema } from './patients.schemas.js';

const router = Router();

// Equipe clínica e administrativa (admin, secretária e dentista) cadastra e atende pacientes.
// Não há exclusão: o paciente é arquivado (active: false), porque o histórico clínico não pode sumir.
router.use(authenticate);
router.get('/', validate({ query: listPatientsQuery }), async (req, res) => {
  res.json(await listPatients(req.auth.clinicId, req.valid.query));
});
router.get('/:id', validate({ params: idParams }), async (req, res) => {
  res.json(await getPatient(req.auth, req.valid.params.id));
});
router.post('/', validate({ body: createPatientSchema }), async (req, res) => {
  res.status(201).json(await createPatient(req.auth, req.valid.body));
});
router.patch('/:id', validate({ params: idParams, body: updatePatientSchema }), async (req, res) => {
  res.json(await updatePatient(req.auth, req.valid.params.id, req.valid.body));
});

export default router;
