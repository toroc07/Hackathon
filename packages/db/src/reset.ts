import { existsSync, unlinkSync } from 'node:fs';
import { closeDatabase, databasePath, getDatabase, runMigrations } from './index.js';
import { seedDatabase } from '../seed/index.js';

const path = databasePath();
closeDatabase();
for (const suffix of ['', '-wal', '-shm']) {
  const target = `${path}${suffix}`;
  if (existsSync(target)) unlinkSync(target);
}

const connection = getDatabase();
const migrations = runMigrations(connection);
seedDatabase(connection);
console.log(`Base recreada en ${path}; migraciones: ${migrations.join(', ') || 'ninguna'}; seed: 30 vehículos.`);
