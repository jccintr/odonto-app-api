import { z } from '../../config/zod.js';
import { cpfField, isoDate, optionalText, phoneField } from '../../utils/fields.js';
import { paginationSchema } from '../../utils/pagination.js';
import { emailField } from '../auth/auth.schemas.js';

const nameField = z.string().trim().min(2, 'Informe o nome.').max(160, 'Nome muito longo.');
const zipField = z.string().transform((v) => v.replace(/\D/g, '')).refine((v) => /^\d{8}$/.test(v), 'CEP inválido.');
const stateField = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'UF inválida.');

const addressFields = {
  zip: zipField,
  street: optionalText(160, 'Rua'),
  number: optionalText(20, 'Número'),
  complement: optionalText(80, 'Complemento'),
  district: optionalText(80, 'Bairro'),
  city: optionalText(80, 'Cidade'),
  state: stateField,
};
const nullable = (fields) => Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, schema.nullable()]));
const addressSchema = z.object(addressFields).partial();
const addressUpdateSchema = z.object(nullable(addressFields)).partial(); // na alteração, cada parte do endereço pode ser limpa com null

const patientFields = {
  name: nameField,
  cpf: cpfField,
  birthDate: isoDate,
  phone: phoneField,
  email: emailField,
  address: addressSchema,
  guardianName: optionalText(160, 'Nome do responsável'),
  guardianPhone: phoneField,
  anamnesis: z.record(z.string(), z.unknown()),
  notes: optionalText(5000, 'Observações'),
  contactConsent: z.boolean(),
};

export const listPatientsQuery = z.object({
  ...paginationSchema,
  active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

// no cadastro, campos opcionais podem ser omitidos
export const createPatientSchema = z.object({
  name: patientFields.name,
  ...Object.fromEntries(Object.entries(patientFields).filter(([key]) => key !== 'name').map(([key, schema]) => [key, schema.optional()])),
});

// na alteração, os opcionais podem ser limpos com null
export const updatePatientSchema = z
  .object({
    name: patientFields.name,
    active: z.boolean(),
    ...Object.fromEntries(
      Object.entries(patientFields).filter(([key]) => !['name', 'contactConsent', 'anamnesis', 'address'].includes(key)).map(([key, schema]) => [key, schema.nullable()]),
    ),
    contactConsent: patientFields.contactConsent,
    anamnesis: patientFields.anamnesis,
    address: addressUpdateSchema,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Informe ao menos um campo para alterar.');
