import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDatabase, type SqliteDatabase } from './client.js';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations/', import.meta.url));
const MIGRATION_NAME = /^(\d{3})_[a-z0-9_-]+\.sql$/i;

interface AppliedMigration {
  name: string;
  checksum: string;
}

export function runMigrations(connection: SqliteDatabase = getDatabase()): string[] {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Map(
    connection.prepare('SELECT name, checksum FROM _migrations').all()
      .map((row) => row as AppliedMigration)
      .map((row) => [row.name, row.checksum]),
  );

  const files = readdirSync(MIGRATIONS_DIRECTORY)
    .filter((file) => MIGRATION_NAME.test(file))
    .sort((a, b) => a.localeCompare(b, 'en'));
  const newlyApplied: string[] = [];

  for (const name of files) {
    const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previousChecksum = applied.get(name);
    if (previousChecksum && previousChecksum !== checksum) {
      throw new Error(`La migración aplicada ${name} cambió de contenido`);
    }
    if (previousChecksum) continue;

    connection.transaction(() => {
      connection.exec(sql);
      connection.prepare('INSERT INTO _migrations (name, checksum, applied_at) VALUES (?, ?, ?)')
        .run(name, checksum, Date.now());
    })();
    newlyApplied.push(name);
  }

  return newlyApplied;
}
