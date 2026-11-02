import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticatePlatform } from '../../middlewares/auth.js';
import { limiters } from '../../middlewares/rateLimit.js';
import * as service from './platform.service.js';
import * as billing from '../billing/billing.platform.js';
import {
  courtesySchema, createClinicSchema, extendTrialSchema, idParams, invoiceParams, listInvoicesQuery, payInvoiceSchema, updatePlanSchema, listClinicsQuery, platformLoginSchema, updateClinicSchema,
} from './platform.schemas.js';

const router = Router();

router.post('/login', limiters.login, validate({ body: platformLoginSchema }), async (req, res) => {
  res.json(await service.platformLogin({ ...req.valid.body, ip: req.ip }));
});

// daqui para baixo: só administradores da plataforma
router.use(authenticatePlatform);

router.get('/overview', async (req, res) => {
  res.json(await service.overview());
});
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

// cobrança: assinatura da clínica, fila de faturas (Pix manual) e planos
router.get('/clinics/:id/billing', validate({ params: idParams }), async (req, res) => {
  res.json(await billing.getClinicBilling(req.valid.params.id));
});
router.post('/clinics/:id/invoices/:invoiceId/pay', validate({ params: invoiceParams, body: payInvoiceSchema }), async (req, res) => {
  res.json(await billing.markInvoicePaid(req.platformAdmin, req.valid.params.id, req.valid.params.invoiceId, req.valid.body.note));
});
router.post('/clinics/:id/trial/extend', validate({ params: idParams, body: extendTrialSchema }), async (req, res) => {
  res.json(await billing.extendTrial(req.platformAdmin, req.valid.params.id, req.valid.body.days));
});
router.put('/clinics/:id/courtesy', validate({ params: idParams, body: courtesySchema }), async (req, res) => {
  res.json(await billing.setCourtesy(req.platformAdmin, req.valid.params.id, req.valid.body));
});
router.get('/invoices', validate({ query: listInvoicesQuery }), async (req, res) => {
  res.json(await billing.listInvoices(req.valid.query));
});
router.get('/plans', async (req, res) => {
  res.json(await billing.listPlans());
});
router.patch('/plans/:id', validate({ params: idParams, body: updatePlanSchema }), async (req, res) => {
  res.json(await billing.updatePlan(req.valid.params.id, req.valid.body));
});

export default router;
