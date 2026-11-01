import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import * as service from './budgets.service.js';
import {
  addItemSchema, budgetParams, changeStatusSchema, createBudgetSchema, itemParams, listBudgetsQuery, performItemSchema,
  updateBudgetSchema, updateItemSchema,
} from './budgets.schemas.js';

const router = Router();
const clinical = requireRole('admin', 'dentist'); // quem monta e executa orçamentos; a secretária consulta e registra aprovação

// Orçamentos: admin e secretária veem todos; o dentista só os próprios (regra aplicada no serviço).
router.use(authenticate);

router.get('/', validate({ query: listBudgetsQuery }), async (req, res) => {
  res.json(await service.listBudgets(req.auth, req.valid.query));
});
router.post('/', clinical, validate({ body: createBudgetSchema }), async (req, res) => {
  res.status(201).json(await service.createBudget(req.auth, req.valid.body));
});
router.get('/:id', validate({ params: budgetParams }), async (req, res) => {
  res.json(await service.getBudget(req.auth, req.valid.params.id));
});
router.patch('/:id', clinical, validate({ params: budgetParams, body: updateBudgetSchema }), async (req, res) => {
  res.json(await service.updateBudget(req.auth, req.valid.params.id, req.valid.body));
});
router.post('/:id/status', validate({ params: budgetParams, body: changeStatusSchema }), async (req, res) => {
  res.json(await service.changeStatus(req.auth, req.valid.params.id, req.valid.body));
});

router.post('/:id/items', clinical, validate({ params: budgetParams, body: addItemSchema }), async (req, res) => {
  res.status(201).json(await service.addItem(req.auth, req.valid.params.id, req.valid.body));
});
router.patch('/:id/items/:itemId', clinical, validate({ params: itemParams, body: updateItemSchema }), async (req, res) => {
  res.json(await service.updateItem(req.auth, req.valid.params.id, req.valid.params.itemId, req.valid.body));
});
router.delete('/:id/items/:itemId', clinical, validate({ params: itemParams }), async (req, res) => {
  res.json(await service.removeItem(req.auth, req.valid.params.id, req.valid.params.itemId));
});
router.post('/:id/items/:itemId/perform', clinical, validate({ params: itemParams, body: performItemSchema }), async (req, res) => {
  res.json(await service.performItem(req.auth, req.valid.params.id, req.valid.params.itemId, req.valid.body));
});
router.post('/:id/items/:itemId/cancel', clinical, validate({ params: itemParams }), async (req, res) => {
  res.json(await service.cancelItem(req.auth, req.valid.params.id, req.valid.params.itemId));
});

export default router;
