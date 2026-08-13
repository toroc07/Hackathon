import { db, type Queryable } from '@/src/server/infra/db';

/** Superficie PostgreSQL compartida por el motor y por transacciones ajenas. */
export function dispatchDatabase(q?: Queryable): Queryable {
  return q ?? db();
}

export type { Queryable };
