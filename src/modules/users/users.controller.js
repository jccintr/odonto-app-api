import * as service from './users.service.js';

export const list = async (req, res) => {
  res.json(await service.listUsers(req.auth.clinicId, req.valid.query));
};

export const get = async (req, res) => {
  res.json(await service.getUser(req.auth.clinicId, req.valid.params.id));
};

export const create = async (req, res) => {
  res.status(201).json(await service.createUser(req.auth.clinicId, req.valid.body));
};

export const update = async (req, res) => {
  res.json(await service.updateUser(req.auth.clinicId, req.auth.userId, req.valid.params.id, req.valid.body));
};
