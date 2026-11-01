import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { idParams } from '../../utils/fields.js';
import { getSettings, updateSettings } from './payouts.settings.js';
import { createRule, deleteRule, listRules, resolveFor, updateRule } from './payouts.rules.js';
import { listBalances, listEntries } from './payouts.entries.js';
import { cancelPayout, createPayout, getPayout, listPayouts } from './payouts.service.js';
import {
  balancesQuery, cancelPayoutSchema, createPayoutSchema, createRuleSchema, listEntriesQuery, listPayoutsQuery, listRulesQuery,
  resolveRuleQuery, updateRuleSchema, updateSettingsSchema,
} from './payouts.schemas.js';

const router = Router();

// O repasse é assunto da administração: nem a secretária nem o dentista acessam.
router.use(authenticate, requireRole('admin'));

router.get('/settings', async (req, res) => res.json(await getSettings(req.auth.clinicId)));
router.patch('/settings', validate({ body: updateSettingsSchema }), async (req, res) => {
  res.json(await updateSettings(req.auth, req.valid.body));
});

router.get('/rules', validate({ query: listRulesQuery }), async (req, res) => {
  res.json(await listRules(req.auth.clinicId, req.valid.query));
});
router.get('/rules/resolve', validate({ query: resolveRuleQuery }), async (req, res) => {
  res.json(await resolveFor(req.auth.clinicId, req.valid.query));
});
router.post('/rules', validate({ body: createRuleSchema }), async (req, res) => {
  res.status(201).json(await createRule(req.auth, req.valid.body));
});
router.patch('/rules/:id', validate({ params: idParams, body: updateRuleSchema }), async (req, res) => {
  res.json(await updateRule(req.auth, req.valid.params.id, req.valid.body));
});
router.delete('/rules/:id', validate({ params: idParams }), async (req, res) => {
  await deleteRule(req.auth, req.valid.params.id);
  res.status(204).end();
});

router.get('/entries', validate({ query: listEntriesQuery }), async (req, res) => {
  res.json(await listEntries(req.auth.clinicId, req.valid.query));
});
router.get('/balances', validate({ query: balancesQuery }), async (req, res) => {
  res.json(await listBalances(req.auth.clinicId, req.valid.query));
});

router.get('/', validate({ query: listPayoutsQuery }), async (req, res) => {
  res.json(await listPayouts(req.auth.clinicId, req.valid.query));
});
router.post('/', validate({ body: createPayoutSchema }), async (req, res) => {
  res.status(201).json(await createPayout(req.auth, req.valid.body));
});
router.get('/:id', validate({ params: idParams }), async (req, res) => {
  res.json(await getPayout(req.auth.clinicId, req.valid.params.id));
});
router.post('/:id/cancel', validate({ params: idParams, body: cancelPayoutSchema }), async (req, res) => {
  res.json(await cancelPayout(req.auth, req.valid.params.id, req.valid.body));
});

export default router;
