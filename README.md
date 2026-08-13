# Hackathon — Despacho Coordinado de Emergencias

Plataforma de coordinación de ambulancias para Cartagena. Convierte múltiples
reportes de una misma emergencia en **un solo incidente** y asigna **exactamente
una unidad**, con una decisión explicable y auditable.

No es un marketplace donde las ambulancias compiten. No reemplaza protocolos
médicos. Es la capa de coordinación que hoy falta.

---

## Arranque rápido

```bash
npm install
cp .env.example .env.local     # pon tu DATABASE_URL de Postgres
npm run db:migrate
npm run db:seed
npm run dev
```

Luego abre:

| Ruta | Quién la usa |
|---|---|
| `/report` | Ciudadano que reporta una emergencia (sin login) |
| `/responder` | Tripulación de la ambulancia |
| `/command` | Despachador / centro de mando |

### Base de datos

Necesitas un PostgreSQL. Opciones: **Vercel Postgres** (Storage → Create),
[Neon](https://neon.tech) en tier gratuito, o uno local.
Pon la connection string en `DATABASE_URL` dentro de `.env.local`.

> `.env.local` está en `.gitignore`. **Nunca subas credenciales al repo.**

| Comando | Qué hace |
|---|---|
| `npm run db:migrate` | Aplica migraciones pendientes. **No destructivo** — es el que corres normalmente |
| `npm run db:seed` | Siembra 30 ambulancias en 6 zonas de Cartagena |
| `npm run db:reset` | **BORRA EL ESQUEMA COMPLETO** y lo recrea. Se niega a correr contra una base remota salvo `ALLOW_REMOTE_RESET=true` |

---

## Estructura

Monolito modular: cinco dominios con fronteras explícitas, separables después.

```
packages/
  contracts/     ⚠ CONGELADO — fuente única de verdad, compartida front/back
  db/            Postgres: cliente, migraciones, seed
apps/web/
  app/report|responder|command/   las tres experiencias
  app/api/**                      route handlers DELGADOS (validan y delegan)
  src/server/modules/**           ← LA LÓGICA DE NEGOCIO VIVE AQUÍ
  src/server/infra/**             db · bus · logger · session · errors
```

### Reglas que no se negocian

1. **El backend es la fuente de verdad.** El frontend nunca decide
   disponibilidad, transición de estado ni asignación.
2. **Los clientes envían acciones, no estados.** `POST /accept`, no
   `PATCH {status:'ACCEPTED'}`. El servidor deriva el estado y valida la
   transición con `assertTransition()`.
3. **Nunca se recalcula el scoring en el frontend.** El motor ya persistió cada
   término en `dispatch_candidates`; la UI los pinta. Duplicar esa aritmética
   crea un segundo motor que se desincroniza.
4. **`packages/contracts` está congelado.** Cambiarlo afecta a los cinco
   dominios: se documenta y se comunica antes de tocarlo.
5. **Un módulo solo importa la interfaz pública de otro** (`modules/x/index.ts`),
   nunca su `internal/`.
6. **El módulo `dispatch` es el único escritor de la tabla `assignments`.**

---

## Cómo decide el sistema

### 1 incidente, N reportes

`POST /incidents` **siempre** crea un reporte; a veces además un incidente, a
veces lo pega a uno existente. Regla explícita:

```
dist ≤ 150m + precisión GPS  Y  Δt ≤ 5min   Y tipo compatible  → fusiona
dist ≤ 400m                  Y  Δt ≤ 10min                     → sugiere al operador
resto                                                           → incidente nuevo
```

### Scoring en segundos-equivalentes

```
score = eta
      + capacidad         45s por nivel de sobre-capacidad
      + cobertura        120s por unidad de déficit que dejas en la zona
      + carga             30s por servicio previo en el turno
      + GPS obsoleto      20s por cada 30s de antigüedad (tope 180s)
      + operacional       60s si opera fuera de su zona
```

Se usan segundos y no pesos abstractos para que la explicación sea una frase
legible y no una fórmula:

> *A16 llega 31s antes, pero es la única unidad libre en Crespo y sacarla deja
> esa zona descubierta ~12 min. Por eso se recomienda A12.*

Las unidades **excluidas se muestran con su motivo**. Un despachador que no ve
por qué se descartó una unidad no confía en el sistema.

### Una sola ambulancia, garantizado

```sql
UPDATE vehicles SET status='RESERVED', current_assignment_id=?, updated_at=?
WHERE id=? AND status='AVAILABLE'
```

Si `changes === 0`, perdiste la carrera → **409** y se re-despacha. La
comprobación va **dentro del WHERE**; nunca `SELECT` → comprobar en JS →
`UPDATE`. Detrás hay índices únicos parciales que rechazan el estado imposible
aunque la aplicación se escriba mal.

La tabla `incident_events` es **append-only por trigger**: la historia de un
incidente no se puede reescribir.

---

## La capa de IA y su límite

La IA **captura y estructura**. Las **reglas deciden**. El **humano manda**.

- Voz (ElevenLabs) atiende llamadas cuando no hay operador libre.
- Transcripción y estructuración convierten una llamada caótica en campos tipados.
- Clasificación normaliza texto libre a vocabulario controlado.

**La prioridad médica NUNCA la determina un modelo.** Sale de una tabla de
reglas explícitas (`contracts/triage.ts`), cada una con su test, y el operador
siempre puede sobrescribirla.

---

## Desarrollo

```bash
npm run typecheck    # debe pasar limpio antes de abrir PR
npm test             # tests por dominio + e2e que cruza los cuatro
npm run build
```

Una feature no está lista porque compile. Antes de mergear:
build y tipos pasan · tests relevantes pasan · contrato de API respetado ·
sin condiciones de carrera evidentes · estados de error manejados ·
la UI refleja el estado real del backend.

### Migraciones — rangos por dominio

Para que dos personas no numeren igual el mismo día:

| Rango | Dueño |
|---|---|
| `001–019` | Plataforma |
| `020–029` | Incidentes |
| `030–039` | Recursos / vehículos |
| `040–049` | Despacho |

Nunca edites una migración ya aplicada: el runner valida checksums y fallará.
Crea una nueva.

---

## Limitaciones conocidas

- **SSE con múltiples instancias**: el bus de eventos es en memoria, así que en
  serverless un cambio en una instancia no llega a los clientes de otra. Los
  hooks `useLive*` caen automáticamente a polling de 3s, que es lo que sostiene
  el realtime en producción hoy.
- **El simulador de flota** necesita un proceso vivo; no corre en serverless.
  Se lanza desde una máquina local apuntando a la URL desplegada.
- **El ETA es haversine × factor de vía urbana**, no ruteo real. Es determinista
  y auditable en vivo, pero no considera el trazado real de calles.
