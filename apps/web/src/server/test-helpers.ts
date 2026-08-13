/**
 * Misma convención que `packages/db/src/reset.ts`: las operaciones destructivas
 * (dropAll, migraciones, seed) solo se ejecutan contra un Postgres local.
 *
 * Las suites de integración que recrean el esquema se omiten cuando
 * DATABASE_URL apunta a una base remota (p.ej. Neon), para no ejecutar
 * DDL destructivo sobre la base de producción/demo ni colgarse con sus
 * tiempos de respuesta.
 */
export function isLocalPostgres(): boolean {
  const url = process.env.DATABASE_URL ?? '';
  return url.includes('localhost') || url.includes('127.0.0.1');
}
