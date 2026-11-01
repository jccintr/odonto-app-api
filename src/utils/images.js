// Regras de imagens do paciente (sem banco nem rede).
export const IMAGE_KINDS = ['xray', 'photo', 'document', 'other']; // radiografia | foto clínica | documento/laudo | outro
// sem PDF: contas gratuitas do Cloudinary não entregam PDF por padrão
export const IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'heic'];
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Pasta do paciente no Cloudinary: a clínica e o paciente fazem parte do caminho. */
export const patientFolder = (root, clinicId, patientId) => `${root}/${clinicId}/${patientId}`;

/** O public_id só vale se for desta clínica, deste paciente e do formato que a API gerou (pasta/uuid). */
export const isOwnPublicId = (publicId, folder) => new RegExp(`^${folder.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/${UUID}$`, 'i').test(publicId);
