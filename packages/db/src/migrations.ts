import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, tx, type Queryable } from './client.js';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations/', import.meta.url));
const MIGRATION_NAME = /^(\d{3})_[a-z0-9_-]+\.sql$/i;

interface AppliedMigration {
  name: string;
  checksum: string;
}

/**
 * Aplica las migraciones pendientes en orden numerico, dentro de una
 * transaccion cada una.
 *
 * El checksum protege contra editar una migracion ya aplicada: en un equipo de
 * 5 personas, cambiar el contenido de una migracion vieja deja cada base en un
 * estado distinto sin que nadie lo note. Preferimos fallar ruidosamente.
 */
export async function runMigrations(): Promise<string[]> {
  const q = db();

  await q.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at BIGINT NOT NULL
    )
  `);

  const rows = await q.many<AppliedMigration & Record<string, unknown>>(
    'SELECT name, checksum FROM _migrations',
  );
  const applied = new Map(rows.map((row) => [row.name, row.checksum]));

  const files = readdirSync(MIGRATIONS_DIRECTORY)
    .filter((file) => MIGRATION_NAME.test(file))
    .sort((a, b) => a.localeCompare(b, 'en'));

  const newlyApplied: string[] = [];

  for (const name of files) {
    const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previousChecksum = applied.get(name);

    if (previousChecksum && previousChecksum !== checksum) {
      throw new Error(
        `La migración ya aplicada ${name} cambió de contenido. ` +
        'Crea una migración nueva en vez de editar una existente.',
      );
    }
    if (previousChecksum) continue;

    await tx(async (t: Queryable) => {
      await t.exec(sql);
      await t.run(
        'INSERT INTO _migrations (name, checksum, applied_at) VALUES (?, ?, ?)',
        [name, checksum, Date.now()],
      );
    });
    newlyApplied.push(name);
  }

  return newlyApplied;
}

/**
 * Borra el esquema completo. Solo para `db:reset` en desarrollo y para los
 * tests: con Postgres no podemos "borrar el archivo" como haciamos con SQLite.
 */
export async function dropAll(): Promise<void> {
  await db().exec(`
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
  `);
}
