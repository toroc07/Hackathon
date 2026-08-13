/**
 * Acceso a datos para los modulos de dominio.
 *
 * MIGRADO DE SQLITE A POSTGRES. Lo que cambia para quien consume esto:
 *
 *   antes (better-sqlite3, sincrono)      ahora (pg, asincrono)
 *   ──────────────────────────────────    ──────────────────────────────────
 *   db.prepare(sql).get(a, b)             await db().one(sql, [a, b])
 *   db.prepare(sql).all(a, b)             await db().many(sql, [a, b])
 *   db.prepare(sql).run(a, b)             await db().run(sql, [a, b])
 *   result.changes                        result.changes   (igual)
 *   db.exec(sql)                          await db().exec(sql)
 *   db.transaction(fn)()                  await tx(async (t) => ...)
 *
 * Los placeholders `?` se siguen escribiendo igual: el cliente los traduce a
 * `$1, $2...` antes de enviarlos. No renumeres nada a mano.
 *
 * REGLA QUE NO CAMBIA: dentro de una transaccion usa SIEMPRE el `t` que recibe
 * el callback, nunca `db()`. Si mezclas, esas consultas salen fuera de la
 * transaccion y pierdes la atomicidad sin que nada falle visiblemente.
 */

// `runMigrations` NO se re-exporta aquí: lee el directorio de migraciones con
// readdirSync y al bundlearlo webpack falla el build. Los tests lo importan
// directamente desde '@dispatch/db/migrations'.
export { db, tx, newId, closePool } from '@dispatch/db';
export type { Queryable } from '@dispatch/db';
