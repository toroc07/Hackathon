-- ============================================================================
-- 001_init.sql — esquema base. PostgreSQL.
--
-- Migrado desde SQLite para desplegar en Vercel (filesystem efimero: un
-- archivo SQLite no sobrevive entre invocaciones serverless).
--
-- Convenciones:
--   · id            TEXT (ULID generado en app, ordenable por tiempo)
--   · timestamps    BIGINT, epoch en MILISEGUNDOS UTC
--   · enums         TEXT + CHECK (mantenido asi a proposito: cambiar un CHECK
--                   es una migracion trivial; cambiar un tipo ENUM de Postgres
--                   requiere ALTER TYPE y bloquea. Con enums que aun se mueven,
--                   CHECK es lo correcto.)
--   · coordenadas   lat/lng DOUBLE PRECISION (sin PostGIS: el haversine vive en
--                   JS, ver contracts/geo.ts, y con decenas de vehiculos un
--                   barrido en memoria tarda microsegundos)
-- ============================================================================

-- ─── ORGANIZACION E IDENTIDAD ───────────────────────────────────────────────

CREATE TABLE organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('EMS','FIRE','POLICE','HOSPITAL','PRIVATE')),
  created_at  BIGINT NOT NULL
);

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  role        TEXT NOT NULL CHECK (role IN ('DISPATCHER','RESPONDER','ADMIN')),
  name        TEXT NOT NULL,
  phone       TEXT,
  created_at  BIGINT NOT NULL
);

-- ─── GEOGRAFIA OPERATIVA ────────────────────────────────────────────────────

CREATE TABLE facilities (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('HOSPITAL','BASE','TRAUMA_CENTER')),
  lat           DOUBLE PRECISION NOT NULL,
  lng           DOUBLE PRECISION NOT NULL,
  capabilities  TEXT NOT NULL DEFAULT '[]',
  created_at    BIGINT NOT NULL
);

CREATE TABLE zones (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  polygon                TEXT NOT NULL,          -- JSON [[lat,lng],...]
  center_lat             DOUBLE PRECISION NOT NULL,
  center_lng             DOUBLE PRECISION NOT NULL,
  target_coverage_units  INTEGER NOT NULL DEFAULT 1,
  population_weight      DOUBLE PRECISION NOT NULL DEFAULT 1.0
);

-- ─── RECURSOS ───────────────────────────────────────────────────────────────

CREATE TABLE vehicles (
  id                     TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL REFERENCES organizations(id),
  callsign               TEXT NOT NULL UNIQUE,
  status                 TEXT NOT NULL CHECK (status IN (
                            'OFFLINE','AVAILABLE','RESERVED','ASSIGNED','EN_ROUTE',
                            'ON_SCENE','TRANSPORTING','UNAVAILABLE','OUT_OF_SERVICE')),
  capability_level       TEXT NOT NULL CHECK (capability_level IN
                            ('MEDICAL_MOTO','BLS','ALS','RESCUE')),
  capabilities           TEXT NOT NULL DEFAULT '[]',
  home_base_id           TEXT REFERENCES facilities(id),
  operating_zone_id      TEXT REFERENCES zones(id),
  -- Denormalizado a proposito: permite que la toma del vehiculo sea un UPDATE
  -- condicional de una sola fila. Ver 002_constraints.sql.
  current_assignment_id  TEXT,
  active_shift_id        TEXT,
  is_simulated           BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at             BIGINT NOT NULL
);

CREATE TABLE shifts (
  id             TEXT PRIMARY KEY,
  vehicle_id     TEXT NOT NULL REFERENCES vehicles(id),
  crew_user_ids  TEXT NOT NULL DEFAULT '[]',
  started_at     BIGINT NOT NULL,
  ended_at       BIGINT
);

-- Historico append-only. Nunca se hace UPDATE aqui.
CREATE TABLE vehicle_locations (
  id           TEXT PRIMARY KEY,
  vehicle_id   TEXT NOT NULL REFERENCES vehicles(id),
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  heading      DOUBLE PRECISION,
  speed_kmh    DOUBLE PRECISION,
  recorded_at  BIGINT NOT NULL
);

-- Una fila por vehiculo: tabla de lectura caliente del motor de despacho.
CREATE TABLE vehicle_current_location (
  vehicle_id   TEXT PRIMARY KEY REFERENCES vehicles(id),
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  heading      DOUBLE PRECISION,
  speed_kmh    DOUBLE PRECISION,
  recorded_at  BIGINT NOT NULL
);

-- ─── INCIDENTES ─────────────────────────────────────────────────────────────

CREATE TABLE incidents (
  id                        TEXT PRIMARY KEY,
  code                      TEXT NOT NULL UNIQUE,
  status                    TEXT NOT NULL CHECK (status IN (
                               'REPORTED','VALIDATING','OPEN','ASSIGNING','ASSIGNED',
                               'EN_ROUTE','ON_SCENE','TRANSPORTING','COMPLETED',
                               'CANCELLED','DUPLICATE','NO_RESOURCE')),
  priority                  TEXT CHECK (priority IN ('P1','P2','P3','P4')),
  type                      TEXT NOT NULL,
  lat                       DOUBLE PRECISION NOT NULL,
  lng                       DOUBLE PRECISION NOT NULL,
  address                   TEXT,
  patient_count             INTEGER NOT NULL DEFAULT 1,
  required_capability       TEXT CHECK (required_capability IN
                               ('MEDICAL_MOTO','BLS','ALS','RESCUE')),
  zone_id                   TEXT REFERENCES zones(id),
  primary_report_id         TEXT,
  merged_into_incident_id   TEXT REFERENCES incidents(id),
  created_at                BIGINT NOT NULL,
  closed_at                 BIGINT
);

-- N reportes -> 1 incidente. Esta tabla ES el mecanismo antiduplicados.
CREATE TABLE incident_reports (
  id                TEXT PRIMARY KEY,
  incident_id       TEXT NOT NULL REFERENCES incidents(id),
  source            TEXT NOT NULL CHECK (source IN ('WEB','WHATSAPP','CALL','SIM')),
  reporter_contact  TEXT,
  description       TEXT,
  lat               DOUBLE PRECISION NOT NULL,
  lng               DOUBLE PRECISION NOT NULL,
  accuracy_m        DOUBLE PRECISION,
  was_merged        BOOLEAN NOT NULL DEFAULT FALSE,
  merge_confidence  DOUBLE PRECISION,
  merge_reason      TEXT,
  idempotency_key   TEXT,
  created_at        BIGINT NOT NULL
);

CREATE TABLE patients (
  id            TEXT PRIMARY KEY,
  incident_id   TEXT NOT NULL REFERENCES incidents(id),
  age_range     TEXT,
  condition_tag TEXT,
  notes         TEXT,
  created_at    BIGINT NOT NULL
);

-- ─── DESPACHO ───────────────────────────────────────────────────────────────

CREATE TABLE dispatch_runs (
  id                       TEXT PRIMARY KEY,
  incident_id              TEXT NOT NULL REFERENCES incidents(id),
  triggered_by             TEXT NOT NULL CHECK (triggered_by IN ('AUTO','DISPATCHER','RETRY','TIMEOUT')),
  triggered_by_user_id     TEXT REFERENCES users(id),
  strategy_version         TEXT NOT NULL,
  candidates_count         INTEGER NOT NULL DEFAULT 0,
  excluded_count           INTEGER NOT NULL DEFAULT 0,
  recommended_vehicle_id   TEXT REFERENCES vehicles(id),
  recommendation_rationale TEXT,
  duration_ms              INTEGER,
  created_at               BIGINT NOT NULL
);

-- LA EXPLICABILIDAD VIVE AQUI: cada termino del score, por separado.
-- El centro de mando los pinta; NO los recalcula.
CREATE TABLE dispatch_candidates (
  id                      TEXT PRIMARY KEY,
  dispatch_run_id         TEXT NOT NULL REFERENCES dispatch_runs(id),
  vehicle_id              TEXT NOT NULL REFERENCES vehicles(id),
  rank                    INTEGER,
  eta_seconds             INTEGER,
  distance_m              INTEGER,
  straight_line_m         INTEGER,
  eta_source              TEXT CHECK (eta_source IN ('HAVERSINE_URBAN','ROUTED','CACHED')),
  capability_penalty      DOUBLE PRECISION NOT NULL DEFAULT 0,
  coverage_penalty        DOUBLE PRECISION NOT NULL DEFAULT 0,
  workload_penalty        DOUBLE PRECISION NOT NULL DEFAULT 0,
  stale_location_penalty  DOUBLE PRECISION NOT NULL DEFAULT 0,
  operational_penalty     DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_score             DOUBLE PRECISION,
  explanation             TEXT NOT NULL DEFAULT '',
  excluded_reason         TEXT
);

CREATE TABLE assignments (
  id                       TEXT PRIMARY KEY,
  incident_id              TEXT NOT NULL REFERENCES incidents(id),
  vehicle_id               TEXT NOT NULL REFERENCES vehicles(id),
  dispatch_run_id          TEXT REFERENCES dispatch_runs(id),
  status                   TEXT NOT NULL CHECK (status IN (
                              'OFFERED','ACCEPTED','REJECTED','EXPIRED','EN_ROUTE',
                              'ON_SCENE','TRANSPORTING','COMPLETED','CANCELLED')),
  offered_at               BIGINT NOT NULL,
  expires_at               BIGINT NOT NULL,
  responded_at             BIGINT,
  reject_reason            TEXT,
  en_route_at              BIGINT,
  arrived_at               BIGINT,
  transport_started_at     BIGINT,
  destination_facility_id  TEXT REFERENCES facilities(id),
  completed_at             BIGINT,
  is_manual_override       BOOLEAN NOT NULL DEFAULT FALSE,
  assigned_by_user_id      TEXT REFERENCES users(id),
  idempotency_key          TEXT
);

-- ─── AUDITORIA ──────────────────────────────────────────────────────────────
-- Append-only. Prohibido UPDATE y DELETE (ver 002_constraints.sql).

CREATE TABLE incident_events (
  id           TEXT PRIMARY KEY,
  incident_id  TEXT NOT NULL REFERENCES incidents(id),
  event_type   TEXT NOT NULL,
  actor_type   TEXT NOT NULL CHECK (actor_type IN
                  ('REPORTER','DISPATCHER','RESPONDER','SYSTEM','SIMULATOR')),
  actor_id     TEXT,
  metadata     TEXT NOT NULL DEFAULT '{}',
  created_at   BIGINT NOT NULL
);
