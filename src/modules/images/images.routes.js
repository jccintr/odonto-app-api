import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { createUploadSignature, getImage, listImages, registerImage, removeImage, updateImage } from './images.service.js';
import { imageParams, listImagesQuery, patientParams, registerImageSchema, updateImageSchema } from './images.schemas.js';

// Montado em /api/patients/:patientId/images
const router = Router({ mergeParams: true });

// Todos consultam (a secretária imprime a ficha); só admin e dentista enviam, alteram ou removem imagens clínicas.
router.use(authenticate);
router.get('/', validate({ params: patientParams, query: listImagesQuery }), async (req, res) => {
  res.json(await listImages(req.auth, req.valid.params.patientId, req.valid.query));
});
router.post('/upload-signature', requireRole('admin', 'dentist'), validate({ params: patientParams }), async (req, res) => {
  res.json(await createUploadSignature(req.auth, req.valid.params.patientId));
});
router.post('/', requireRole('admin', 'dentist'), validate({ params: patientParams, body: registerImageSchema }), async (req, res) => {
  res.status(201).json(await registerImage(req.auth, req.valid.params.patientId, req.valid.body));
});
router.get('/:imageId', validate({ params: imageParams }), async (req, res) => {
  res.json(await getImage(req.auth, req.valid.params.patientId, req.valid.params.imageId));
});
router.patch('/:imageId', requireRole('admin', 'dentist'), validate({ params: imageParams, body: updateImageSchema }), async (req, res) => {
  res.json(await updateImage(req.auth, req.valid.params.patientId, req.valid.params.imageId, req.valid.body));
});
router.delete('/:imageId', requireRole('admin', 'dentist'), validate({ params: imageParams }), async (req, res) => {
  await removeImage(req.auth, req.valid.params.patientId, req.valid.params.imageId);
  res.status(204).end();
});

export default router;
