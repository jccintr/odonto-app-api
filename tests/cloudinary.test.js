// O serviço REAL do Cloudinary, com o SDK simulado (os demais testes usam o armazenamento falso de helpers/fakeStorage.js).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  config: vi.fn(),
  utils: { api_sign_request: vi.fn(), private_download_url: vi.fn() },
  api: { resource: vi.fn() },
  uploader: { destroy: vi.fn() },
  url: vi.fn(),
}));
vi.mock('cloudinary', () => ({ v2: sdk }));

vi.resetModules(); // o setup trocou o serviço pelo falso; aqui queremos o real
const storage = await vi.importActual('../src/services/cloudinary.js');

const configure = () => {
  vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'minha-nuvem');
  vi.stubEnv('CLOUDINARY_API_KEY', 'chave');
  vi.stubEnv('CLOUDINARY_API_SECRET', 'segredo');
};

beforeEach(() => {
  vi.unstubAllEnvs();
  Object.values({ ...sdk.utils, ...sdk.api, ...sdk.uploader }).forEach((fn) => fn.mockReset());
  sdk.config.mockReset();
  sdk.url.mockReset();
});

describe('storageEnabled', () => {
  it('exige nome da nuvem, chave e segredo', () => {
    expect(storage.storageEnabled()).toBe(false);
    vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'n');
    vi.stubEnv('CLOUDINARY_API_KEY', 'k');
    expect(storage.storageEnabled()).toBe(false);
    vi.stubEnv('CLOUDINARY_API_SECRET', 's');
    expect(storage.storageEnabled()).toBe(true);
  });
});

describe('sem configuração', () => {
  it('toda operação responde 503 STORAGE_NOT_CONFIGURED e não chama o SDK', async () => {
    const calls = [() => storage.signUpload('a'), () => storage.fetchAsset('a'), () => storage.destroyAsset('a'), () => storage.downloadUrl('a', 'jpg', 60)];
    for (const call of calls) {
      await expect(Promise.resolve().then(call)).rejects.toMatchObject({ status: 503, extra: { code: 'STORAGE_NOT_CONFIGURED' } });
    }
    expect(sdk.config).not.toHaveBeenCalled();
  });
});

describe('com configuração', () => {
  beforeEach(configure);

  it('assina o envio com o segredo, só dos campos que a API decide', () => {
    sdk.utils.api_sign_request.mockReturnValue('assinatura');
    const signed = storage.signUpload('odontoapp/c/p/u');
    expect(sdk.config).toHaveBeenCalledWith({ cloud_name: 'minha-nuvem', api_key: 'chave', api_secret: 'segredo', secure: true });
    const [signedFields, secret] = sdk.utils.api_sign_request.mock.calls[0];
    expect(secret).toBe('segredo');
    expect(signedFields).toEqual({ public_id: 'odontoapp/c/p/u', type: 'private', allowed_formats: 'jpg,jpeg,png,webp,heic', timestamp: expect.any(Number) });
    expect(signed).toEqual({
      uploadUrl: 'https://api.cloudinary.com/v1_1/minha-nuvem/image/upload',
      fields: { ...signedFields, api_key: 'chave', signature: 'assinatura' },
    });
    expect(signed.fields).not.toHaveProperty('api_secret');
  });

  it('consulta o arquivo como "authenticated" e devolve só o necessário', async () => {
    sdk.api.resource.mockResolvedValue({ bytes: 1234, format: 'png', width: 800, height: 600, secure_url: 'https://qualquer' });
    expect(await storage.fetchAsset('a/b')).toEqual({ bytes: 1234, format: 'png', width: 800, height: 600 });
    expect(sdk.api.resource).toHaveBeenCalledWith('a/b', { type: 'private', resource_type: 'image' });
    sdk.api.resource.mockResolvedValue({ bytes: 10, format: 'pdf' });
    expect(await storage.fetchAsset('a/b')).toEqual({ bytes: 10, format: 'pdf', width: null, height: null });
  });

  it('arquivo que não existe vira null (404 em qualquer formato de erro do SDK); outro erro vira 502', async () => {
    sdk.api.resource.mockRejectedValueOnce({ http_code: 404 });
    expect(await storage.fetchAsset('x')).toBeNull();
    sdk.api.resource.mockRejectedValueOnce({ error: { http_code: 404 } });
    expect(await storage.fetchAsset('x')).toBeNull();
    sdk.api.resource.mockRejectedValueOnce({ http_code: 500 });
    await expect(storage.fetchAsset('x')).rejects.toMatchObject({ status: 502, extra: { code: 'STORAGE_ERROR' } });
    sdk.api.resource.mockRejectedValueOnce(undefined);
    await expect(storage.fetchAsset('x')).rejects.toMatchObject({ status: 502 });
  });

  it('apaga o arquivo invalidando o cache; falha vira 502', async () => {
    sdk.uploader.destroy.mockResolvedValue({ result: 'ok' });
    await storage.destroyAsset('a/b');
    expect(sdk.uploader.destroy).toHaveBeenCalledWith('a/b', { type: 'private', resource_type: 'image', invalidate: true });
    sdk.uploader.destroy.mockRejectedValue(new Error('rede'));
    await expect(storage.destroyAsset('a/b')).rejects.toMatchObject({ status: 502, extra: { code: 'STORAGE_ERROR' } });
  });

  it('o link de download expira no prazo pedido', () => {
    sdk.utils.private_download_url.mockReturnValue('https://link');
    const before = Math.floor(Date.now() / 1000);
    const link = storage.downloadUrl('a/b', 'jpg', 600);
    const [publicId, format, options] = sdk.utils.private_download_url.mock.calls[0];
    expect([publicId, format]).toEqual(['a/b', 'jpg']);
    expect(options).toMatchObject({ type: 'private', resource_type: 'image' });
    expect(options.expires_at).toBeGreaterThanOrEqual(before + 600);
    expect(options.expires_at).toBeLessThanOrEqual(before + 601);
    expect(link).toEqual({ url: 'https://link', expiresAt: new Date(options.expires_at * 1000).toISOString() });
  });

  it('só usa envio, consulta, remoção e download assinado: nenhuma transformação (que gastaria créditos)', async () => {
    sdk.utils.api_sign_request.mockReturnValue('s');
    sdk.utils.private_download_url.mockReturnValue('u');
    sdk.api.resource.mockResolvedValue({ bytes: 1, format: 'jpg' });
    sdk.uploader.destroy.mockResolvedValue({});
    storage.signUpload('a');
    await storage.fetchAsset('a');
    await storage.destroyAsset('a');
    storage.downloadUrl('a', 'jpg', 60);
    expect(sdk.url).not.toHaveBeenCalled();
    expect(storage).not.toHaveProperty('thumbnailUrl');
  });
});
