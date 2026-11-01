import * as service from './auth.service.js';

export const login = async (req, res) => {
  res.json(await service.login({ ...req.valid.body, ip: req.ip }));
};

export const refresh = async (req, res) => {
  res.json(await service.refreshSession(req.valid.body.refreshToken));
};

export const logout = async (req, res) => {
  await service.logout(req.valid.body.refreshToken);
  res.status(204).end();
};

export const me = async (req, res) => {
  res.json(await service.getProfile(req.auth.userId));
};

export const verifyEmail = async (req, res) => {
  await service.verifyEmail(req.valid.body.token);
  res.json({ message: 'E-mail verificado com sucesso.' });
};

export const resendVerification = async (req, res) => {
  await service.requestVerification(req.valid.body.email);
  res.json({ message: 'Se o e-mail estiver cadastrado e ainda não verificado, você receberá um novo link.' });
};

export const forgotPassword = async (req, res) => {
  await service.forgotPassword(req.valid.body.email);
  res.json({ message: 'Se o e-mail estiver cadastrado, você receberá as instruções para redefinir a senha.' });
};

export const resetPassword = async (req, res) => {
  await service.resetPassword(req.valid.body);
  res.json({ message: 'Senha redefinida com sucesso. Entre com a nova senha.' });
};

export const changePassword = async (req, res) => {
  res.json(await service.changePassword({ userId: req.auth.userId, ...req.valid.body }));
};
