import { z } from '../../config/zod.js';
import { isoDate, optionalText, uuidField } from '../../utils/fields.js';
import { paginationSchema } from '../../utils/pagination.js';
import { IMAGE_KINDS } from '../../utils/images.js';
import { toothField } from '../budgets/budgets.schemas.js';

export const patientParams = z.object({ patientId: uuidField });
export const imageParams = z.object({ patientId: uuidField, imageId: uuidField });

const kindField = z.enum(IMAGE_KINDS, { error: 'Tipo de imagem inválido.' });
const notesField = optionalText(500, 'Observações');

export const registerImageSchema = z.object({
  publicId: z.string().trim().min(1, 'Informe o identificador do arquivo enviado.').max(300, 'Identificador muito longo.'),
  kind: kindField,
  tooth: toothField.optional(),
  takenOn: isoDate.optional(),
  notes: notesField.optional(),
});

export const updateImageSchema = z
  .object({ kind: kindField, tooth: toothField.nullable(), takenOn: isoDate, notes: notesField.nullable() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Informe ao menos um campo para alterar.');

export const listImagesQuery = z.object({ ...paginationSchema, kind: kindField.optional(), tooth: z.coerce.number().pipe(toothField).optional() });
