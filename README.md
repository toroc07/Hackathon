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
| `/` | Ciudadano: reporta la emergencia **por voz**, sin login, con confirmación |
| `/api/track/[token]` | Seguimiento en vivo de la ambulancia con un token, sin cuenta |

> Las antiguas pantallas `/report`, `/responder` y `/command` se unificaron en
> una sola experiencia ciudadana: grabar → enviar → confirmar.

### Base de datos

Necesitas un PostgreSQL. La base compartida del equipo vive en
[Neon](https://neon.tech) (ver `carpeta pg_api/`). Alternativas:
**Vercel Postgres** (Storage → Create) o uno local.
Pon la connection string en `DATABASE_URL` dentro de `.env.local`
(usa la URL de Neon del `.env.example`; reemplaza `TU_PASSWORD` por la
real del panel de Neon).

> `.env.local` está en `.gitignore`. **Nunca subas credenciales al repo.**

| Comando | Qué hace |
|---|---|
| `npm run db:migrate` | Aplica migraciones pendientes. **No destructivo** — es el que corres normalmente |
| `npm run db:seed` | Siembra 30 ambulancias en 6 zonas de Cartagena |
| `npm run db:reset` | **BORRA EL ESQUEMA COMPLETO** y lo recrea. Se niega a correr contra una base remota salvo `ALLOW_REMOTE_RESET=true` |

### API genérica de la base (`carpeta pg_api/`)

El equipo subió una API **FastAPI + Postgres (Neon)** que detecta las tablas
de la base automáticamente (SQLAlchemy `automap`) y genera endpoints CRUD
para cada una — sin escribir modelos a mano:

| Endpoint | Qué hace |
|---|---|
| `GET /{tabla}` | Lista con paginación (`?skip=0&limit=50`) |
| `GET /{tabla}/{id}` | Un registro por su primary key |
| `POST /{tabla}` | Crea un registro |
| `PUT /{tabla}/{id}` | Actualiza un registro |
| `DELETE /{tabla}/{id}` | Borra un registro |

Correrla (en `carpeta pg_api/`):

```bash
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                               # pega la DATABASE_URL real de Neon
uvicorn main:app --reload                          # docs en http://127.0.0.1:8000/docs
```

> El `.env` de `carpeta pg_api/` también está en `.gitignore`. Las tablas sin
> primary key solo generan listado (`GET`); las de PK compuesta no tienen
> `GET/{id}`, `PUT` ni `DELETE` individuales en esta versión genérica.

---

## Estructura

Monolito modular: cinco dominios con fronteras explícitas, separables después.

```
packages/
  contracts/          ⚠ CONGELADO — fuente única de verdad, compartida front/back
  db/                 Postgres: cliente, migraciones, seed
apps/web/
  app/                               landing + reporte por voz (una sola pantalla)
  app/api/**                         route handlers DELGADOS (validan y delegan)
  src/server/modules/**              ← LA LÓGICA DE NEGOCIO VIVE AQUÍ
  src/server/infra/**                db · bus · logger · session · errors
  src/server/test-helpers.ts         guard para tests que recrean el esquema
scripts/
  check-layers.mjs                   valida la frontera internal/* de cada módulo
backend/                             servicio de audio por teléfono (opcional)
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
7. **Las capas se validan en CI** (`npm run check:layers`): nadie puede
   importar `modules/x/internal/*` desde fuera de su módulo; las rutas entran
   por la interfaz pública de `modules/x/index.ts`.
8. **Los tests que recrean el esquema solo corren contra Postgres local.**
   `isLocalPostgres()` los salta cuando `DATABASE_URL` apunta a una base remota
   (misma convención que `db:reset`).

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

### Reporte por voz

`POST /api/incidents/audio` toma el audio del ciudadano, lo transcribe
(véase [La capa de IA](#la-capa-de-ia-y-su-límite)) y delega en la misma
maquinaria de los reportes escritos: dedupe → `triage()` → transición de
estado. Peculiaridades:

- **El reporte nunca se pierde por culpa de la transcripción.** Si ningún
  motor responde, se crea igual con el audio guardado como evidencia y el
  incidente queda marcado para revisión humana.
- **Idempotencia por audio.** El cliente calcula un hash del audio y lo manda
  como `Idempotency-Key`: reintentar reenvía la misma grabación y no duplica.
- **Confirmación de tipo.** Si la confianza es baja o no hubo transcripción,
  la app pide al ciudadano que confirme el tipo con botones
  (`fallbackType`); el sistema nunca depende solo del audio para despachar.
- **Seguimiento sin registro.** Se devuelve un token opaco de 128 bits que
  alimenta `/api/track/[token]` (estilo Uber/Rappi, ver `contracts/audio.ts`).

El tope de subida (`2 MB`, ~60s de opus) se valida **en el cliente y en el
servidor**: decodificar un audio mentiroso de 50 MB tumbaría la función.

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

### Transcripción de voz — Groq first

El reporte por voz de la web transcribe con una cadena de motores en orden,
y se corta en el primero que responde:

```
1. Groq Whisper        whisper-large-v3-turbo (API OpenAI-compatible)
2. ElevenLabs Scribe   si el anterior no responde
3. OpenAI Whisper      whisper-1
```

- **Presupuesto duro de 12s por motor** (`TRANSCRIPTION_TIMEOUT_MS`): un
  proveedor lento no puede tumbar el endpoint.
- **Degradación elegante.** Sin key configurada o con los tres motores caídos,
  el reporte se crea igual con el audio guardado y `transcription: null`
  (véase "Reporte por voz"). La UI responde con `needsConfirmation`.
- **Solo el formato se estructura por modelo** (`suggestedType`, señales
  críticas); son sugerencias que alimentan `triage()`. El motor que produjo la
  transcripción se persiste (`engine`) para auditar cambios de proveedor.
- **Confianza < 0.55** → revisión humana en vez de asumir que se entendió.

---

## Desarrollo

```bash
npm run typecheck    # debe pasar limpio antes de abrir PR
npm run check:layers # fronteras de módulos: nadie importa internal/* ajeno
npm test             # tests por dominio + e2e
npm run build
npm run ci           # los cuatro en orden, como lo ve el CI
```

Una feature no está lista porque compile. Antes de mergear:
build y tipos pasan · check:layers pasa · tests relevantes pasan ·
contrato de API respetado · sin condiciones de carrera evidentes ·
estados de error manejados · la UI refleja el estado real del backend.

### Tests y base de datos

`vitest` carga el entorno desde `.env.local` con `dotenv` (las variables ya
definidas en el shell tienen prioridad). Los tres suites que **recrean el
esquema** — e2e, dispatch y vehicles — se saltan
(`describe.skipIf(!isLocalPostgres())`) cuando `DATABASE_URL` no es localhost:
así nadie borra la base compartida del equipo por accidente al correr `npm test`.

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
