import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Carga el .env de la app (apps/web) y el .env.local de la raiz del monorepo
// (DATABASE_URL y otros). Los valores ya presentes en el entorno no se pisan.
dotenv.config({ path: fileURLToPath(new URL('../../.env.local', import.meta.url)) });
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });
dotenv.config({ path: fileURLToPath(new URL('.env.local', import.meta.url)) });

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
