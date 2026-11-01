import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticatePlatform } from '../../middlewares/auth.js';
import { limiters } from '../../middlewares/rateLimit.js';
import * as service from './platform.service.js';
import {
  createClinicSchema, idParams, listClinicsQuery, platformLoginSchema, updateClinicSchema,
} from './platform.schemas.js';

const router = Router();

router.post('/login', limiters.login, validate({ body: platformLoginSchema }), async (req, res) => {
  res.json(await service.platformLogin({ ...req.valid.body, ip: req.ip }));
});

// daqui para baixo: só administradores da plataforma
router.use(authenticatePlatform);

router.get('/clinics', validate({ query: listClinicsQuery }), async (req, res) => {
  res.json(await service.listClinics(req.valid.query));
});
router.post('/clinics', validate({ body: createClinicSchema }), async (req, res) => {
  res.status(201).json(await service.createClinic(req.valid.body));
});
router.get('/clinics/:id', validate({ params: idParams }), async (req, res) => {
  res.json(await service.getClinic(req.valid.params.id));
});
router.patch('/clinics/:id', validate({ params: idParams, body: updateClinicSchema }), async (req, res) => {
  res.json(await service.updateClinic(req.valid.params.id, req.valid.body));
});

export default router;
