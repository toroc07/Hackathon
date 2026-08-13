import { closePool, dropAll, runMigrations } from './index.js';
import { seedDatabase } from '../seed/index.js';

/**
 * Recrea la base desde cero: esquema limpio, migraciones y seed.
 *
 * Con SQLite bastaba con borrar el archivo. Con Postgres hay que tirar el
 * esquema explicitamente, asi que este script es DESTRUCTIVO: nunca lo apuntes
 * a una base compartida del equipo sin avisar.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  const isLocal = url.includes('localhost') || url.includes('127.0.0.1');

  if (!isLocal && process.env.ALLOW_REMOTE_RESET !== 'true') {
    console.error(
      'db:reset borra TODO el esquema y DATABASE_URL no apunta a localhost.\n' +
      'Si de verdad quieres resetear la base remota, ejecuta con ALLOW_REMOTE_RESET=true.',
    );
    process.exit(1);
  }

  await dropAll();
  const migrations = await runMigrations();
  await seedDatabase();
  await closePool();

  console.log(
    `Base recreada; migraciones: ${migrations.join(', ') || 'ninguna'}; seed: 30 vehículos.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
