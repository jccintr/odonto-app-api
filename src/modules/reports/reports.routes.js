import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { monthlyReport, trendReport } from './reports.service.js';
import { monthlyQuery, trendQuery } from './reports.schemas.js';

const router = Router();

// Relatórios gerenciais reúnem faturamento e repasse: só a administração.
router.use(authenticate, requireRole('admin'));
router.get('/monthly', validate({ query: monthlyQuery }), async (req, res) => {
  res.json(await monthlyReport(req.auth.clinicId, req.valid.query));
});
router.get('/trend', validate({ query: trendQuery }), async (req, res) => {
  res.json(await trendReport(req.auth.clinicId, req.valid.query));
});

export default router;
