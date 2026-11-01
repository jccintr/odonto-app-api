import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/auth.js';
import { limiters } from '../../middlewares/rateLimit.js';
import * as controller from './auth.controller.js';
import {
  changePasswordSchema, forgotPasswordSchema, loginSchema, refreshSchema, resetPasswordSchema, tokenSchema,
} from './auth.schemas.js';

const router = Router();

router.post('/login', limiters.login, validate({ body: loginSchema }), controller.login);
router.post('/refresh', validate({ body: refreshSchema }), controller.refresh);
router.post('/logout', validate({ body: refreshSchema }), controller.logout);
router.get('/me', authenticate, controller.me);

router.post('/verify-email', limiters.password, validate({ body: tokenSchema }), controller.verifyEmail);
router.post('/resend-verification', limiters.password, validate({ body: forgotPasswordSchema }), controller.resendVerification);
router.post('/forgot-password', limiters.password, validate({ body: forgotPasswordSchema }), controller.forgotPassword);
router.post('/reset-password', limiters.password, validate({ body: resetPasswordSchema }), controller.resetPassword);
router.post('/change-password', authenticate, validate({ body: changePasswordSchema }), controller.changePassword);

export default router;
