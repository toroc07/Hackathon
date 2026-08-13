import { closePool } from './client.js';
import { seedDatabase } from '../seed/index.js';

/** Entrypoint de `npm run db:seed`. Aplica migraciones y siembra la flota. */
async function main(): Promise<void> {
  await seedDatabase();
  await closePool();
  console.log('Seed listo: 30 vehículos en 6 zonas de Cartagena.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
