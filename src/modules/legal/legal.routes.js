import { Router } from 'express';
import { z } from '../../config/zod.js';
import { validate } from '../../middlewares/validate.js';
import { getDocument, LEGAL_TYPES } from './documents.js';

const router = Router();

const typeParams = z.object({ type: z.enum(LEGAL_TYPES, { error: 'Documento inválido (terms ou privacy).' }) });

router.get('/:type', validate({ params: typeParams }), (req, res) => res.json(getDocument(req.valid.params.type)));

export default router;
