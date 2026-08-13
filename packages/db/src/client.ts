/**
 * Cliente PostgreSQL.
 *
 * Migrado desde better-sqlite3 para poder desplegar en Vercel: el filesystem
 * serverless es efimero, un archivo SQLite no sobrevive entre invocaciones.
 *
 * DIFERENCIA QUE IMPORTA: better-sqlite3 era sincrono y de un solo escritor,
 * lo que hacia casi imposible intercalar dos asignaciones. Postgres permite
 * escrituras concurrentes reales desde varias instancias serverless, asi que
 * la correccion ahora depende de:
 *   1. UPDATE condicional (... WHERE status='AVAILABLE') — bloquea la fila
 *   2. los indices unicos parciales de 002_constraints.sql
 * Ambos ya estaban; aqui pasan de red de seguridad a mecanismo principal.
 */

import pg, { Pool, type PoolClient, type QueryResultRow } from 'pg';

// ─── Parsers de tipos ───────────────────────────────────────────────────────
// `pg` devuelve BIGINT (oid 20) como STRING por defecto, para no perder
// precision en valores mayores que Number.MAX_SAFE_INTEGER.
//
// Todos nuestros BIGINT son timestamps epoch en milisegundos (~1.8e12), muy por
// debajo de ese limite (9e15). Sin este parser, cada `created_at` y `expires_at`
// llegaria como "1786635390187" y la aritmetica se romperia en silencio:
// `expires_at < now` compararia string con numero, los ETA saldrian NaN y las
// ofertas nunca expirarian. Lo convertimos una vez, aqui.
pg.types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));

// NUMERIC (oid 1700) tambien llega como string. No lo usamos hoy (los scores
// son DOUBLE PRECISION), pero si alguien añade una columna NUMERIC lo notara
// aqui en vez de en produccion.
pg.types.setTypeParser(1700, (value: string) => Number.parseFloat(value));

declare global {
  // eslint-disable-next-line no-var
  var __dispatchPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL no esta definida. Copia .env.example a .env.local y apunta ' +
      'a tu Postgres (local o Vercel/Neon).',
    );
  }

  return new Pool({
    connectionString,
    // Serverless: muchas instancias efimeras, cada una con pocas conexiones.
    // Un pool grande por instancia agota el limite de conexiones del servidor.
    max: process.env.VERCEL ? 1 : 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Los Postgres gestionados (Neon, Vercel, Supabase) exigen TLS pero usan
    // certificados que el trust store de Node no siempre reconoce.
    ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
      ? undefined
      : { rejectUnauthorized: false },
  });
}

/** Singleton: el hot-reload de dev crearia un pool nuevo en cada recarga. */
export function getPool(): Pool {
  if (!globalThis.__dispatchPool) globalThis.__dispatchPool = createPool();
  return globalThis.__dispatchPool;
}

/**
 * Traduce placeholders `?` (estilo SQLite) a `$1, $2...` (estilo Postgres).
 *
 * Existe para que la migracion de ~124 call sites sea mecanica en vez de una
 * renumeracion a mano en cada consulta, que es exactamente donde se colarian
 * los errores silenciosos. Respeta literales entre comillas simples y los
 * operadores JSON de Postgres (`?`, `?|`, `?&`), que hoy no usamos pero
 * romperian el dia que alguien los use.
 */
export function toPgPlaceholders(sql: string): string {
  let out = '';
  let index = 0;
  let inString = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;

    if (ch === "'") {
      inString = !inString;
      out += ch;
      continue;
    }
    if (!inString && ch === '?') {
      const next = sql[i + 1];
      if (next === '|' || next === '&' || next === '?') {   // operador JSON
        out += ch + next;
        i += 1;
        continue;
      }
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += ch;
  }
  return out;
}

export interface Queryable {
  /** Una fila o undefined. Reemplaza a `.get()`. */
  one<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** Todas las filas. Reemplaza a `.all()`. */
  many<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Escritura. `changes` reemplaza a `.run().changes` — clave para el UPDATE
   *  condicional de la asignacion atomica: changes===0 significa que perdiste
   *  la carrera. */
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  /** Varias sentencias sin parametros. Reemplaza a `.exec()`. */
  exec(sql: string): Promise<void>;
}

function wrap(runner: Pool | PoolClient): Queryable {
  return {
    async one<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
      const result = await runner.query<T>(toPgPlaceholders(sql), params);
      return result.rows[0];
    },
    async many<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
      const result = await runner.query<T>(toPgPlaceholders(sql), params);
      return result.rows;
    },
    async run(sql: string, params: unknown[] = []) {
      const result = await runner.query(toPgPlaceholders(sql), params);
      return { changes: result.rowCount ?? 0 };
    },
    async exec(sql: string) {
      await runner.query(sql);
    },
  };
}

/** Acceso a la base fuera de transaccion. */
export function db(): Queryable {
  return wrap(getPool());
}

/**
 * Transaccion. El callback recibe un Queryable ligado a UNA conexion:
 * todo lo que se ejecute dentro comparte transaccion.
 *
 * Si el callback lanza, se hace ROLLBACK y el error se propaga. Es lo que
 * permite que la asignacion atomica sea todo-o-nada: o se toma el vehiculo,
 * se crea la asignacion y se escribe el evento, o no pasa nada.
 */
export async function tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(wrap(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { /* la conexion ya murio */ });
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (globalThis.__dispatchPool) {
    await globalThis.__dispatchPool.end();
    globalThis.__dispatchPool = undefined;
  }
}
