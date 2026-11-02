import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { limiters } from '../../middlewares/rateLimit.js';
import * as service from './signup.service.js';
import { signupSchema } from './signup.schemas.js';

const router = Router();

router.get('/options', async (req, res) => res.json(await service.getOptions()));
router.post('/', limiters.signup, validate({ body: signupSchema }), async (req, res) => {
  res.status(201).json(await service.signup(req.valid.body, { ip: req.ip, userAgent: req.get('user-agent') }));
});

export default router;
