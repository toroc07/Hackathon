import { getDatabase, type SqliteDatabase } from '@/src/server/infra/db';

export interface DispatchStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface DispatchTransaction<TArgs extends unknown[], TResult> {
  (...args: TArgs): TResult;
  immediate(...args: TArgs): TResult;
}

/** Superficie mínima para ejecutar el motor contra SQLite real o una DB en memoria. */
export interface DispatchDataAccess {
  prepare(sql: string): DispatchStatement;
  transaction<TArgs extends unknown[], TResult>(
    operation: (...args: TArgs) => TResult,
  ): DispatchTransaction<TArgs, TResult>;
}

export function dispatchDatabase(database?: DispatchDataAccess): DispatchDataAccess {
  return database ?? (getDatabase() as unknown as DispatchDataAccess);
}

export type { SqliteDatabase };
