import { closePool, runMigrations } from './index.js';

/**
 * Entrypoint de `npm run db:migrate`. NO destructivo: solo aplica lo pendiente.
 *
 * Es el comando que corre el equipo (y el que se ejecuta antes de desplegar),
 * a diferencia de `db:reset`, que borra el esquema entero.
 */
async function main(): Promise<void> {
  const applied = await runMigrations();
  await closePool();
  console.log(
    applied.length
      ? `Migraciones aplicadas: ${applied.join(', ')}`
      : 'Sin migraciones pendientes.',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
