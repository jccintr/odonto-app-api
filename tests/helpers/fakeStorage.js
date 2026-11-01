// Armazenamento de imagens FALSO para os testes (no lugar de src/services/cloudinary.js): guarda tudo em memória.
// Nenhum teste fala com o Cloudinary de verdade; o serviço real é testado em cloudinary.test.js com o SDK simulado.
import { HttpError } from '../../src/utils/errors.js';
import { IMAGE_FORMATS } from '../../src/utils/images.js';

export const fake = {
  enabled: true,
  assets: new Map(),
  destroyed: [],
  failFetch: false,
  failDestroy: false,
  reset() {
    this.enabled = true;
    this.assets.clear();
    this.destroyed.length = 0;
    this.failFetch = false;
    this.failDestroy = false;
  },
  /** Simula o app enviando o arquivo com a assinatura. */
  upload(publicId, { bytes = 200_000, format = 'jpg', width = 1600, height = 900 } = {}) {
    this.assets.set(publicId, { bytes, format, width, height });
  },
};

const off = () => new HttpError(503, 'O armazenamento de imagens não está configurado.', { code: 'STORAGE_NOT_CONFIGURED' });

export const storageEnabled = () => fake.enabled;

export function signUpload(publicId) {
  if (!fake.enabled) throw off();
  return {
    uploadUrl: 'https://upload.fake.test/v1_1/demo/image/upload',
    fields: { public_id: publicId, type: 'private', allowed_formats: IMAGE_FORMATS.join(','), timestamp: 1_700_000_000, api_key: 'chave-publica', signature: `assinatura-de-${publicId}` },
  };
}

export async function fetchAsset(publicId) {
  if (!fake.enabled) throw off();
  if (fake.failFetch) throw new HttpError(502, 'Não foi possível consultar o armazenamento de imagens.', { code: 'STORAGE_ERROR' });
  return fake.assets.get(publicId) ?? null;
}

export async function destroyAsset(publicId) {
  if (!fake.enabled) throw off();
  if (fake.failDestroy) throw new HttpError(502, 'Não foi possível apagar a imagem no armazenamento.', { code: 'STORAGE_ERROR' });
  fake.assets.delete(publicId);
  fake.destroyed.push(publicId);
}

export function downloadUrl(publicId, format, ttlSeconds) {
  if (!fake.enabled) throw off();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { url: `https://download.fake.test/${publicId}.${format}?expires_at=${expiresAt}`, expiresAt: new Date(expiresAt * 1000).toISOString() };
}
