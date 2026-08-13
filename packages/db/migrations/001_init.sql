-- ============================================================================
-- 001_init.sql — esquema base. SQLite.
-- OWNER: A5 (platform). Rango de migraciones A5: 001-019.
-- A1: 020-029 · A2: 030-039 · A3: 040-049.  NO invadas rango ajeno.
--
-- Convenciones:
--   · id            TEXT (ULID generado en app, ordenable por tiempo)
--   · timestamps    INTEGER, epoch en MILISEGUNDOS UTC
--   · enums         TEXT + CHECK (SQLite no tiene tipo enum)
--   · coordenadas   lat/lng REAL (sin PostGIS; haversine en JS, ver geo.ts)
-- ============================================================================

PRAGMA journal_mode = WAL;      -- lectores concurrentes sin bloquear al escritor
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ─── ORGANIZACIÓN E IDENTIDAD ───────────────────────────────────────────────

CREATE TABLE organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('EMS','FIRE','POLICE','HOSPITAL','PRIVATE')),
  created_at  INTEGER NOT NULL
);

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  role        TEXT NOT NULL CHECK (role IN ('DISPATCHER','RESPONDER','ADMIN')),
  name        TEXT NOT NULL,
  phone       TEXT,
  created_at  INTEGER NOT NULL
);

-- ─── GEOGRAFÍA OPERATIVA ────────────────────────────────────────────────────

CREATE TABLE facilities (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('HOSPITAL','BASE','TRAUMA_CENTER')),
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  capabilities  TEXT NOT NULL DEFAULT '[]',   -- JSON array
  created_at    INTEGER NOT NULL
);

CREATE TABLE zones (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  -- Polígono como JSON [[lat,lng],...]. Point-in-polygon en JS: son 3-8 zonas.
  polygon                TEXT NOT NULL,
  center_lat             REAL NOT NULL,
  center_lng             REAL NOT NULL,
  -- Cuántas unidades libres "deberían" cubrir esta zona. Base de coverage_penalty.
  target_coverage_units  INTEGER NOT NULL DEFAULT 1,
  population_weight      REAL NOT NULL DEFAULT 1.0
);

-- ─── RECURSOS ───────────────────────────────────────────────────────────────

CREATE TABLE vehicles (
  id                     TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL REFERENCES organizations(id),
  callsign               TEXT NOT NULL UNIQUE,          -- 'A17'
  status                 TEXT NOT NULL CHECK (status IN (
                            'OFFLINE','AVAILABLE','RESERVED','ASSIGNED','EN_ROUTE',
                            'ON_SCENE','TRANSPORTING','UNAVAILABLE','OUT_OF_SERVICE')),
  capability_level       TEXT NOT NULL CHECK (capability_level IN
                            ('MEDICAL_MOTO','BLS','ALS','RESCUE')),
  capabilities           TEXT NOT NULL DEFAULT '[]',    -- JSON: ['OXYGEN','DEFIB',...]
  home_base_id           TEXT REFERENCES facilities(id),
  operating_zone_id      TEXT REFERENCES zones(id),
  -- Denormalizado a propósito: hace la asignación atómica un UPDATE condicional
  -- de una sola fila. Ver 002_constraints.sql.
  current_assignment_id  TEXT,
  active_shift_id        TEXT,
  is_simulated           INTEGER NOT NULL DEFAULT 0,
  updated_at             INTEGER NOT NULL
);

CREATE TABLE shifts (
  id             TEXT PRIMARY KEY,
  vehicle_id     TEXT NOT NULL REFERENCES vehicles(id),
  crew_user_ids  TEXT NOT NULL DEFAULT '[]',   -- JSON array
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER
);

-- Histórico append-only. Nunca se hace UPDATE aquí.
CREATE TABLE vehicle_locations (
  id           TEXT PRIMARY KEY,
  vehicle_id   TEXT NOT NULL REFERENCES vehicles(id),
  lat          REAL NOT NULL,
  lng          REAL NOT NULL,
  heading      REAL,
  speed_kmh    REAL,
  recorded_at  INTEGER NOT NULL
);

-- Una fila por vehículo. Es la tabla de lectura caliente del motor de dispatch:
-- evita un GROUP BY sobre el histórico en cada corrida.
CREATE TABLE vehicle_current_location (
  vehicle_id   TEXT PRIMARY KEY REFERENCES vehicles(id),
  lat          REAL NOT NULL,
  lng          REAL NOT NULL,
  heading      REAL,
  speed_kmh    REAL,
  recorded_at  INTEGER NOT NULL
);

-- ─── INCIDENTES ─────────────────────────────────────────────────────────────

CREATE TABLE incidents (
  id                        TEXT PRIMARY KEY,
  code                      TEXT NOT NULL UNIQUE,       -- 'INC-482'
  status                    TEXT NOT NULL CHECK (status IN (
                               'REPORTED','VALIDATING','OPEN','ASSIGNING','ASSIGNED',
                               'EN_ROUTE','ON_SCENE','TRANSPORTING','COMPLETED',
                               'CANCELLED','DUPLICATE','NO_RESOURCE')),
  priority                  TEXT CHECK (priority IN ('P1','P2','P3','P4')),
  type                      TEXT NOT NULL,
  lat                       REAL NOT NULL,
  lng                       REAL NOT NULL,
  address                   TEXT,
  patient_count             INTEGER NOT NULL DEFAULT 1,
  required_capability       TEXT CHECK (required_capability IN
                               ('MEDICAL_MOTO','BLS','ALS','RESCUE')),
  zone_id                   TEXT REFERENCES zones(id),
  primary_report_id         TEXT,
  merged_into_incident_id   TEXT REFERENCES incidents(id),  -- si status='DUPLICATE'
  created_at                INTEGER NOT NULL,
  closed_at                 INTEGER
);

-- N reportes → 1 incidente. Esta tabla ES el mecanismo antiduplicados (§6).
CREATE TABLE incident_reports (
  id                      TEXT PRIMARY KEY,
  incident_id             TEXT NOT NULL REFERENCES incidents(id),
  source                  TEXT NOT NULL CHECK (source IN ('WEB','WHATSAPP','CALL','SIM')),
  reporter_contact        TEXT,
  description             TEXT,
  lat                     REAL NOT NULL,
  lng                     REAL NOT NULL,
  accuracy_m              REAL,
  -- Trazabilidad del merge: por qué este reporte se pegó a este incidente.
  was_merged              INTEGER NOT NULL DEFAULT 0,
  merge_confidence        REAL,
  merge_reason            TEXT,
  created_at              INTEGER NOT NULL
);

CREATE TABLE patients (
  id           TEXT PRIMARY KEY,
  incident_id  TEXT NOT NULL REFERENCES incidents(id),
  age_range    TEXT,
  condition_tag TEXT,
  notes        TEXT,
  created_at   INTEGER NOT NULL
);

-- ─── DESPACHO ───────────────────────────────────────────────────────────────

-- Una corrida del motor. Existe para poder responder "¿por qué esa ambulancia?"
-- meses después, no solo en pantalla.
CREATE TABLE dispatch_runs (
  id                     TEXT PRIMARY KEY,
  incident_id            TEXT NOT NULL REFERENCES incidents(id),
  triggered_by           TEXT NOT NULL CHECK (triggered_by IN ('AUTO','DISPATCHER','RETRY','TIMEOUT')),
  triggered_by_user_id   TEXT REFERENCES users(id),
  strategy_version       TEXT NOT NULL,     -- 'v1' — versiona el algoritmo
  candidates_count       INTEGER NOT NULL DEFAULT 0,
  excluded_count         INTEGER NOT NULL DEFAULT 0,
  recommended_vehicle_id TEXT REFERENCES vehicles(id),
  duration_ms            INTEGER,
  created_at             INTEGER NOT NULL
);

-- ⚠ LA EXPLICABILIDAD VIVE AQUÍ. Cada término del score se persiste por
-- separado. El Command Center los pinta; NO los recalcula (§14, §29).
CREATE TABLE dispatch_candidates (
  id                      TEXT PRIMARY KEY,
  dispatch_run_id         TEXT NOT NULL REFERENCES dispatch_runs(id),
  vehicle_id              TEXT NOT NULL REFERENCES vehicles(id),
  rank                    INTEGER,               -- NULL si fue excluido
  eta_seconds             INTEGER,
  distance_m              INTEGER,
  straight_line_m         INTEGER,
  eta_source              TEXT CHECK (eta_source IN ('HAVERSINE_URBAN','ROUTED','CACHED')),
  capability_penalty      REAL NOT NULL DEFAULT 0,
  coverage_penalty        REAL NOT NULL DEFAULT 0,
  workload_penalty        REAL NOT NULL DEFAULT 0,
  stale_location_penalty  REAL NOT NULL DEFAULT 0,
  operational_penalty     REAL NOT NULL DEFAULT 0,
  total_score             REAL,                  -- segundos-equivalentes; menor = mejor
  excluded_reason         TEXT                   -- NULL ⇒ es candidato viable
);

CREATE TABLE assignments (
  id                       TEXT PRIMARY KEY,
  incident_id              TEXT NOT NULL REFERENCES incidents(id),
  vehicle_id               TEXT NOT NULL REFERENCES vehicles(id),
  dispatch_run_id          TEXT REFERENCES dispatch_runs(id),
  status                   TEXT NOT NULL CHECK (status IN (
                              'OFFERED','ACCEPTED','REJECTED','EXPIRED','EN_ROUTE',
                              'ON_SCENE','TRANSPORTING','COMPLETED','CANCELLED')),
  offered_at               INTEGER NOT NULL,
  expires_at               INTEGER NOT NULL,     -- timeout de oferta
  responded_at             INTEGER,
  reject_reason            TEXT,
  en_route_at              INTEGER,
  arrived_at               INTEGER,
  transport_started_at     INTEGER,
  destination_facility_id  TEXT REFERENCES facilities(id),
  completed_at             INTEGER,
  is_manual_override       INTEGER NOT NULL DEFAULT 0,
  assigned_by_user_id      TEXT REFERENCES users(id),
  -- §15: doble tap en un celular en movimiento no puede crear dos asignaciones.
  idempotency_key          TEXT
);

-- ─── AUDITORÍA (§12) ────────────────────────────────────────────────────────
-- Append-only. Prohibido UPDATE y DELETE sobre esta tabla.

CREATE TABLE incident_events (
  id           TEXT PRIMARY KEY,
  incident_id  TEXT NOT NULL REFERENCES incidents(id),
  event_type   TEXT NOT NULL,
  actor_type   TEXT NOT NULL CHECK (actor_type IN
                  ('REPORTER','DISPATCHER','RESPONDER','SYSTEM','SIMULATOR')),
  actor_id     TEXT,
  metadata     TEXT NOT NULL DEFAULT '{}',   -- JSON
  created_at   INTEGER NOT NULL
);
