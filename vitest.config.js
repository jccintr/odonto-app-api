import { defineConfig } from 'vitest/config';

// Os testes usam um PostgreSQL de verdade (necessário para testar o RLS). Por padrão, o globalSetup sobe um
// PostgreSQL embutido (pacote embedded-postgres) num diretório temporário: não precisa instalar nada.
// Para usar um banco seu, defina TEST_DATABASE_URL (o nome do banco precisa terminar com _test).
export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/globalSetup.js'],
    setupFiles: ['./tests/setup.js'],
    fileParallelism: false, // os arquivos compartilham o mesmo banco de teste
    hookTimeout: 120000,
    testTimeout: 30000,
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'segredo-de-teste',
      JWT_SECRET_PLATFORM: 'segredo-da-plataforma-de-teste',
      BCRYPT_ROUNDS: '4',
      WEB_URL: 'http://localhost:5173',
      // nunca usar o SMTP real nos testes, mesmo que o ambiente tenha essas variáveis
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASSWORD: '',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      // index.js e scripts/ são só cola de linha de comando; toda a lógica fica em módulos testados
      exclude: ['src/index.js', 'src/scripts/**'],
      reporter: ['text', 'html'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
