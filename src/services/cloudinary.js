// Única porta para o Cloudinary, usando só recursos do plano gratuito. Os arquivos ficam como "private": o original só é
// acessível por um link de download assinado pela API, que expira. Não geramos miniaturas nem outras transformações
// (cada uma gasta créditos e seria uma URL sem prazo).
import { v2 as cloudinary } from 'cloudinary';
import { config } from '../config/env.js';
import { HttpError } from '../utils/errors.js';
import { IMAGE_FORMATS } from '../utils/images.js';

const ASSET_TYPE = 'private';

export const storageEnabled = () => Boolean(config.cloudinaryCloudName && config.cloudinaryApiKey && config.cloudinaryApiSecret);

function client() {
  if (!storageEnabled()) throw new HttpError(503, 'O armazenamento de imagens não está configurado.', { code: 'STORAGE_NOT_CONFIGURED' });
  cloudinary.config({ cloud_name: config.cloudinaryCloudName, api_key: config.cloudinaryApiKey, api_secret: config.cloudinaryApiSecret, secure: true });
  return cloudinary;
}

/** Assina um upload direto (app → Cloudinary) com o public_id já definido pela API. */
export function signUpload(publicId) {
  const c = client();
  const fields = { public_id: publicId, type: ASSET_TYPE, allowed_formats: IMAGE_FORMATS.join(','), timestamp: Math.floor(Date.now() / 1000) };
  const signature = c.utils.api_sign_request(fields, config.cloudinaryApiSecret);
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${config.cloudinaryCloudName}/image/upload`,
    fields: { ...fields, api_key: config.cloudinaryApiKey, signature },
  };
}

/** Dados reais do arquivo enviado (não confiamos no que o app diz). null se o arquivo não existe. */
export async function fetchAsset(publicId) {
  const c = client();
  try {
    const r = await c.api.resource(publicId, { type: ASSET_TYPE, resource_type: 'image' });
    return { bytes: r.bytes, format: r.format, width: r.width ?? null, height: r.height ?? null };
  } catch (err) {
    if (err?.http_code === 404 || err?.error?.http_code === 404) return null;
    throw new HttpError(502, 'Não foi possível consultar o armazenamento de imagens.', { code: 'STORAGE_ERROR' });
  }
}

export async function destroyAsset(publicId) {
  const c = client();
  try {
    await c.uploader.destroy(publicId, { type: ASSET_TYPE, resource_type: 'image', invalidate: true });
  } catch {
    throw new HttpError(502, 'Não foi possível apagar a imagem no armazenamento.', { code: 'STORAGE_ERROR' });
  }
}

/** Link para baixar o original; deixa de funcionar em `ttlSeconds`. */
export function downloadUrl(publicId, format, ttlSeconds) {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { url: client().utils.private_download_url(publicId, format, { type: ASSET_TYPE, resource_type: 'image', expires_at: expiresAt }), expiresAt: new Date(expiresAt * 1000).toISOString() };
}
