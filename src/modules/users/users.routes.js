import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import * as controller from './users.controller.js';
import { createUserSchema, idParams, listQuery, updateUserSchema } from './users.schemas.js';

const router = Router();

// gestão de usuários: só o administrador da clínica
router.use(authenticate, requireRole('admin'));
router.get('/', validate({ query: listQuery }), controller.list);
router.post('/', validate({ body: createUserSchema }), controller.create);
router.get('/:id', validate({ params: idParams }), controller.get);
router.patch('/:id', validate({ params: idParams, body: updateUserSchema }), controller.update);

export default router;
