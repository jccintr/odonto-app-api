import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/auth.js';
import { idParams } from '../../utils/fields.js';
import { changeStatus, createAppointment, getAppointment, listAppointments, updateAppointment } from './appointments.service.js';
import { changeStatusSchema, createAppointmentSchema, listAppointmentsQuery, updateAppointmentSchema } from './appointments.schemas.js';

const router = Router();

// Agenda: admin e secretária veem tudo; o dentista só a própria (regra aplicada no serviço).
router.use(authenticate);
router.get('/', validate({ query: listAppointmentsQuery }), async (req, res) => {
  res.json(await listAppointments(req.auth, req.valid.query));
});
router.get('/:id', validate({ params: idParams }), async (req, res) => {
  res.json(await getAppointment(req.auth, req.valid.params.id));
});
router.post('/', validate({ body: createAppointmentSchema }), async (req, res) => {
  res.status(201).json(await createAppointment(req.auth, req.valid.body));
});
router.patch('/:id', validate({ params: idParams, body: updateAppointmentSchema }), async (req, res) => {
  res.json(await updateAppointment(req.auth, req.valid.params.id, req.valid.body));
});
router.post('/:id/status', validate({ params: idParams, body: changeStatusSchema }), async (req, res) => {
  res.json(await changeStatus(req.auth, req.valid.params.id, req.valid.body));
});

export default router;
