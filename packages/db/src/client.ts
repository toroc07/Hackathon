import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type SqliteDatabase = InstanceType<typeof Database>;

const DEFAULT_DATABASE_PATH = fileURLToPath(new URL('../data/dispatch.sqlite', import.meta.url));

declare global {
  // eslint-disable-next-line no-var
  var __dispatchSqlite: SqliteDatabase | undefined;
  // eslint-disable-next-line no-var
  var __dispatchDrizzle: BetterSQLite3Database | undefined;
}

export function databasePath(): string {
  return resolve(process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH);
}

function openDatabase(): SqliteDatabase {
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  const connection = new Database(path);
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  connection.pragma('busy_timeout = 5000');
  connection.pragma('synchronous = NORMAL');
  return connection;
}

export function getDatabase(): SqliteDatabase {
  globalThis.__dispatchSqlite ??= openDatabase();
  return globalThis.__dispatchSqlite;
}

export function getOrm(): BetterSQLite3Database {
  globalThis.__dispatchDrizzle ??= drizzle(getDatabase());
  return globalThis.__dispatchDrizzle;
}

export function closeDatabase(): void {
  const connection = globalThis.__dispatchSqlite;
  if (connection?.open) connection.close();
  globalThis.__dispatchSqlite = undefined;
  globalThis.__dispatchDrizzle = undefined;
}

export type { SqliteDatabase };
