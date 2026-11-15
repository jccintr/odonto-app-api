import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/auth.js';
import { limiters } from '../../middlewares/rateLimit.js';
import * as controller from './auth.controller.js';
import {
  changePasswordSchema, clinicParams, forgotPasswordSchema, loginSchema, refreshSchema, resetPasswordSchema, switchClinicSchema, tokenSchema, updateMeSchema,
} from './auth.schemas.js';

const router = Router();

router.post('/login', limiters.login, validate({ body: loginSchema }), controller.login);
router.post('/refresh', validate({ body: refreshSchema }), controller.refresh);
router.post('/logout', validate({ body: refreshSchema }), controller.logout);
router.get('/me', authenticate, controller.me);
router.patch('/me', authenticate, validate({ body: updateMeSchema }), controller.updateMe);

// uma pessoa pode trabalhar em mais de uma clínica: lista as clínicas dela e troca a sessão sem pedir a senha de novo
router.get('/clinics', authenticate, controller.clinics);
router.post('/switch-clinic', authenticate, validate({ body: switchClinicSchema }), controller.switchClinic);
router.get('/invitations', authenticate, controller.invitations);
router.post('/invitations/:clinicId/accept', authenticate, validate({ params: clinicParams }), controller.acceptInvitation);
router.post('/accept-invite', limiters.password, validate({ body: tokenSchema }), controller.acceptInvite);

router.post('/verify-email', limiters.password, validate({ body: tokenSchema }), controller.verifyEmail);
router.post('/resend-verification', limiters.password, validate({ body: forgotPasswordSchema }), controller.resendVerification);
router.post('/forgot-password', limiters.password, validate({ body: forgotPasswordSchema }), controller.forgotPassword);
router.post('/reset-password', limiters.password, validate({ body: resetPasswordSchema }), controller.resetPassword);
router.post('/change-password', authenticate, validate({ body: changePasswordSchema }), controller.changePassword);

export default router;
