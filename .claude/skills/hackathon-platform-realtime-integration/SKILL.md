---
name: hackathon-platform-realtime-integration
description: Plataforma del sistema de despacho — esqueleto Next.js, SQLite con Drizzle y better-sqlite3, migraciones, tipos compartidos, sesión y roles, realtime por SSE con fallback a polling, tiles PMTiles offline, seed de Cartagena, simulador de flota, tests de integración, CI y coordinación de merge. Úsala para trabajo en packages/db/, src/server/infra/, src/hooks/, apps/sim y configuración del repo.
---

# Platform & Integration — A5

Los otros cuatro construyen features. Tú construyes el suelo sobre el que pisan.
Si tu capa es sólida, los cuatro avanzan en paralelo sin chocar. Si es frágil,
los bloqueas a todos a la vez.

Vas 30 minutos por delante del resto (W1). Ese adelanto es la única dependencia
serial real del proyecto: no lo desperdicies puliendo.

## OWNS

```
packages/db/**                         migraciones, cliente, seed
src/server/infra/**                    db · realtime · logger · session
src/hooks/useLive*.ts                  primitivas de realtime compartidas
src/components/ui/**                   primitivas visuales compartidas
src/server/modules/audit/**  notifications/**  simulation/**
apps/sim/**
package.json · next.config.ts · tsconfig · Dockerfile · CI
packages/db/migrations/00*.sql - 01*.sql   ← rango 001-019
```

## MUST NOT TOUCH

Las reglas de negocio de los otros cuatro dominios. Provees el motor; ellos
conducen. Si un módulo necesita algo de infraestructura, lo añades **en infra**,
no dentro de su dominio.

## STACK — DECIDIDO, NO REABRIR

```
Next.js (App Router, output: 'standalone')   un solo proceso Node, un solo deploy
SQLite + better-sqlite3 + Drizzle            un archivo, cero servicios cloud
SSE                                          realtime sin WebSocket server
MapLibre GL JS + PMTiles locales             mapa que funciona sin internet
simulador in-process                         setInterval, no worker aparte
```

**Cero dependencias externas en runtime.** Si vas a añadir una librería que llama
a la red en producción, para y consúltalo con Athena primero.

### Configuración de SQLite — no la improvises

```ts
const db = new Database(path);
db.pragma('journal_mode = WAL');   // lectores no bloquean al escritor
db.pragma('foreign_keys = ON');    // OFF por defecto en SQLite. Actívalo.
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL'); // seguro con WAL, mucho más rápido
```

En Next.js App Router, `better-sqlite3` es nativo: añádelo a
`serverExternalPackages` en `next.config.ts` o el build falla. Y **una sola
instancia por proceso** — expórtala como singleton; el hot-reload de dev crea
varias si no la guardas en `globalThis`.

`better-sqlite3` es síncrono. Eso es una ventaja aquí (nos da atomicidad casi
gratis), pero significa que una query lenta bloquea el event loop. Mantén el
camino caliente en índices y no hagas escaneos completos.

## REALTIME POR SSE

Un event bus en memoria + un endpoint `GET /api/stream?topics=...` que mantiene
la conexión abierta. Como todo corre en un proceso, no necesitas Redis ni pub/sub.

```
domain module → bus.emit('incident:updated', payload) → SSE → useLiveIncidents()
```

Reglas:
- **Un solo** hook por recurso, expuesto por ti. Nadie más escribe clientes SSE.
- **Fallback a polling de 3s desde el día 1**, no como parche de última hora.
  El hook decide solo: si SSE no conecta en 2s, hace polling. La UI ni se entera.
- Heartbeat cada 15s o los proxies cortan la conexión.
- Cierra los streams al desmontar o acumularás conexiones muertas.

## TILES OFFLINE

Extrae el bbox de Cartagena a un `.pmtiles` **en tiempo de setup** (una descarga,
una vez) y sírvelo desde `public/`. En la demo no se toca la red. Documenta el
comando de extracción en el README para que sea reproducible.
Ver `maplibre-pmtiles-patterns` en las fuentes.

## SEED Y SIMULADOR

Seed de Cartagena: bases, hospitales reales (Serena del Mar, Bocagrande, Naval),
zonas (Centro/Getsemaní, Bocagrande/Castillogrande, Crespo, Manga, La Boquilla,
Olaya) con `target_coverage_units` y `population_weight` realistas.

Simulador con `DEMO_MODE=true`: 20-50 ambulancias.

**Regla dura: el simulador es un cliente HTTP del API público.** Nunca escribe en
la DB directamente. Si lo hace, deja de ser un test de integración vivo y se
convierte en un truco de demo que oculta bugs reales.

Tick de 1s: mueve vehículos con `advanceToward()` de `contracts/geo.ts`, publica
posiciones vía `POST /vehicles/:id/location`, acepta o rechaza ofertas con
probabilidad configurable, y avanza los estados por el flujo real.

Escenarios guionizados y reproducibles (§21, §22): Bocagrande, Crespo 30s después,
y la tormenta de 4 reportes duplicados. Con **semilla fija**: la demo tiene que
dar el mismo resultado todas las veces. Un escenario que a veces sale distinto no
se puede ensayar.

## COORDINACIÓN DE MERGE

Eres el guardián de la integración:
- Rangos de migración por agente (A5 001-019 · A1 020-029 · A2 030-039 · A3 040-049)
- CI: typecheck + build + tests + `npm run check:layers`
- `check:layers` es un script tuyo que falla si algún import cruza una frontera
  prohibida (p.ej. `app/command/**` importando de `src/server/modules/dispatch/**`).
  Automatiza la regla §29 en vez de confiar en la revisión humana.

## CRITERIOS DE ACEPTACIÓN

- [ ] `npm install && npm run db:reset && npm run dev` levanta el sistema completo
- [ ] `DEMO_MODE=true` → 30 ambulancias moviéndose por Cartagena vía API real
- [ ] SSE actualiza 3 pestañas en <2s; si lo matas, el polling toma el relevo solo
- [ ] Mapa carga con el wifi apagado
- [ ] Los 3 escenarios corren con semilla fija y resultado idéntico
- [ ] `check:layers` falla ante un import cruzado (probado con uno a propósito)
- [ ] Test E2E del flujo completo reporte→cierre en CI
- [ ] `db:reset` deja un estado limpio y demostrable en <5s

## ERRORES PROHIBIDOS

- Simulador escribiendo en la DB sin pasar por el API
- Varias instancias de la conexión SQLite
- Olvidar `foreign_keys = ON` (SQLite lo desactiva por defecto)
- Dejar que cada agente escriba su propio cliente de realtime
- Añadir una dependencia externa de runtime sin consultarlo
- Escenarios de demo no deterministas
- Implementar reglas de negocio de otro dominio "porque era rápido"

## FUENTES

- [honra-io/drizzle-best-practices](https://github.com/honra-io/drizzle-best-practices)
  y [almeidazs/better-drizzle](https://github.com/almeidazs/better-drizzle) —
  patrón SKILL.md + `references/`, guardas de repositorio
- [BarisSozen/claude · pitfalls-drizzle-orm](https://github.com/BarisSozen/claude/blob/main/.claude/skills/pitfalls-drizzle-orm/SKILL.md)
- [gustavocadev/nextjs-drizzle-orm-sqlite](https://github.com/gustavocadev/nextjs-drizzle-orm-sqlite) — integración de referencia
- [maplibre/maplibre-agent-skills](https://github.com/maplibre/maplibre-agent-skills) (MIT) — `maplibre-pmtiles-patterns`
- [LambdaTest/agent-skills · playwright-skill](https://github.com/LambdaTest/agent-skills/tree/main/playwright-skill) — E2E

Todas `quarantined` en `athena/tools/external/`: se extraen patrones, no se copia código.

## FORMATO DE REPORTE (§27)

```
AGENT: A5
DOMAIN: platform
DONE / WORKING / BLOCKED / CONTRACT CHANGES / FILES TOUCHED / NEEDS FROM OTHER AGENTS
```
