/**
 * Superficie que consume la aplicación web.
 *
 * `runMigrations` y `dropAll` NO se exportan aquí a propósito: leen el
 * directorio de migraciones con `readdirSync`, y al bundlearlos webpack intenta
 * resolver esa ruta como un módulo y el build falla. Son herramientas de CLI y
 * de tests, así que viven en su propia entrada: `@dispatch/db/migrations`.
 */

export { db, tx, getPool, closePool, toPgPlaceholders } from './client.js';
export type { Queryable } from './client.js';
export { newId } from './id.js';
