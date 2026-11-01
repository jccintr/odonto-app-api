import { z } from '../../config/zod.js';
import { isoDate, optionalText, uuidField } from '../../utils/fields.js';
import { CONDITIONS } from '../../utils/tooth.js';
import { facesField, toothField } from '../budgets/budgets.schemas.js';

export const patientParams = z.object({ patientId: uuidField });
export const recordParams = z.object({ patientId: uuidField, recordId: uuidField });

export const createRecordSchema = z
  .object({
    tooth: toothField,
    faces: facesField.optional(),
    condition: z.enum(CONDITIONS, { error: 'Condição inválida.' }),
    notes: optionalText(500, 'Observações').optional(),
    recordedOn: isoDate.optional(),
  });
