// Imagens e radiografias do paciente. O app envia o arquivo direto ao Cloudinary com uma assinatura da API;
// depois "registra" a imagem aqui, e a API confere no Cloudinary que o arquivo existe, é deste paciente e tem tamanho aceitável.
import { randomUUID } from 'node:crypto';
import { config } from '../../config/env.js';
import { withTenant } from '../../db/tenant.js';
import { recordAudit } from '../../services/audit.js';
import { destroyAsset, downloadUrl, fetchAsset, signUpload } from '../../services/cloudinary.js';
import { businessDate } from '../../utils/dates.js';
import { toImageDto } from '../../utils/dto.js';
import { conflict, notFound, unprocessable } from '../../utils/errors.js';
import { IMAGE_FORMATS, isOwnPublicId, patientFolder } from '../../utils/images.js';
import { pageResult, paginate } from '../../utils/pagination.js';

const SIGNATURE_VALID_SECONDS = 3600;
const COLUMN = { takenOn: 'taken_on' };
const toColumns = (input) => Object.fromEntries(Object.entries(input).map(([key, value]) => [COLUMN[key] ?? key, value]));

const folderOf = (auth, patientId) => patientFolder(config.cloudinaryFolder, auth.clinicId, patientId);

const assertPatient = async (trx, patientId) => {
  if (!(await trx('patients').where({ id: patientId }).first('id'))) throw notFound('Paciente');
};

const audit = (trx, auth, entity, entityId, action, changes) =>
  recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity, entityId, action, changes });

/** Cada imagem sai com um link de download que expira (o app mostra reduzindo a imagem no próprio aparelho). */
function withLinks(row) {
  const download = downloadUrl(row.public_id, row.format, config.imageUrlTtlSeconds);
  return toImageDto(row, { url: download.url, urlExpiresAt: download.expiresAt });
}

const findImage = async (trx, patientId, imageId) => {
  const row = await trx('patient_images').where({ id: imageId, patient_id: patientId }).whereNull('removed_at').first();
  if (!row) throw notFound('Imagem');
  return row;
};

/** Passo 1: a API escolhe o public_id e assina o envio. O app manda os `fields` + o arquivo ao `uploadUrl`. */
export function createUploadSignature(auth, patientId) {
  return withTenant(auth.clinicId, async (trx) => {
    await assertPatient(trx, patientId);
    const publicId = `${folderOf(auth, patientId)}/${randomUUID()}`;
    return {
      publicId, ...signUpload(publicId),
      allowedFormats: IMAGE_FORMATS, maxBytes: config.imageMaxMb * 1024 * 1024, validForSeconds: SIGNATURE_VALID_SECONDS,
    };
  });
}

/** Passo 2: depois do envio, registra a imagem na ficha do paciente. */
export function registerImage(auth, patientId, input) {
  return withTenant(auth.clinicId, async (trx) => {
    await assertPatient(trx, patientId);
    if (!isOwnPublicId(input.publicId, folderOf(auth, patientId))) {
      throw unprocessable('Este arquivo não pertence a este paciente.', { code: 'INVALID_PUBLIC_ID' });
    }
    if (await trx('patient_images').where({ public_id: input.publicId }).first('id')) {
      throw conflict('Esta imagem já foi registrada.', { code: 'IMAGE_ALREADY_REGISTERED' });
    }
    const asset = await fetchAsset(input.publicId);
    if (!asset) throw unprocessable('O arquivo não foi encontrado no armazenamento. Envie a imagem antes de registrá-la.', { code: 'UPLOAD_NOT_FOUND' });
    if (asset.bytes > config.imageMaxMb * 1024 * 1024) {
      await destroyAsset(input.publicId);
      throw unprocessable(`O arquivo passa de ${config.imageMaxMb} MB.`, { code: 'FILE_TOO_LARGE' });
    }

    const [row] = await trx('patient_images')
      .insert({
        clinic_id: auth.clinicId, patient_id: patientId, kind: input.kind, public_id: input.publicId, format: asset.format, bytes: asset.bytes,
        width: asset.width, height: asset.height, tooth: input.tooth, taken_on: input.takenOn ?? businessDate(), notes: input.notes, uploaded_by: auth.userId,
      })
      .returning('*');
    await audit(trx, auth, 'patient_image', row.id, 'create');
    return withLinks(row);
  });
}

/** Imagens do paciente (a leitura da ficha é auditada). */
export function listImages(auth, patientId, filters) {
  const apply = (query) =>
    query.where({ patient_id: patientId }).whereNull('removed_at').modify((q) => {
      if (filters.kind) q.where({ kind: filters.kind });
      if (filters.tooth) q.where({ tooth: filters.tooth });
    });
  return withTenant(auth.clinicId, async (trx) => {
    await assertPatient(trx, patientId);
    const [{ count }] = await apply(trx('patient_images')).count({ count: '*' });
    const { limit, offset } = paginate(filters);
    const rows = await apply(trx('patient_images')).orderBy([{ column: 'taken_on', order: 'desc' }, { column: 'created_at', order: 'desc' }]).limit(limit).offset(offset);
    await audit(trx, auth, 'patient', patientId, 'read_images');
    return pageResult(rows.map(withLinks), Number(count), filters);
  });
}

export function getImage(auth, patientId, imageId) {
  return withTenant(auth.clinicId, async (trx) => {
    const row = await findImage(trx, patientId, imageId);
    await audit(trx, auth, 'patient_image', imageId, 'read');
    return withLinks(row);
  });
}

export function updateImage(auth, patientId, imageId, changes) {
  return withTenant(auth.clinicId, async (trx) => {
    await findImage(trx, patientId, imageId);
    const [row] = await trx('patient_images').where({ id: imageId }).update({ ...toColumns(changes), updated_at: new Date() }).returning('*');
    await audit(trx, auth, 'patient_image', imageId, 'update', { fields: Object.keys(changes) });
    return withLinks(row);
  });
}

/** Apaga o arquivo no Cloudinary e marca a imagem como removida (o registro fica, com quem removeu e quando). */
export function removeImage(auth, patientId, imageId) {
  return withTenant(auth.clinicId, async (trx) => {
    const row = await findImage(trx, patientId, imageId);
    await destroyAsset(row.public_id);
    await trx('patient_images').where({ id: imageId }).update({ removed_at: new Date(), removed_by: auth.userId, updated_at: new Date() });
    await audit(trx, auth, 'patient_image', imageId, 'remove');
  });
}
