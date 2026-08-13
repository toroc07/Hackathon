-- ============================================================================
-- 002_constraints.sql — índices que HACEN CUMPLIR la corrección.
-- OWNER: A5. Revisión obligatoria de A3 antes de tocar nada aquí.
--
-- Esto NO es optimización. Es la última línea de defensa contra el riesgo #1
-- del producto: dos incidentes quedándose con la misma ambulancia.
--
-- Defensa en profundidad, tres capas:
--   1. better-sqlite3 es SÍNCRONO y single-writer  → no hay intercalado real
--   2. BEGIN IMMEDIATE + UPDATE condicional        → la app verifica y toma
--   3. estos índices únicos parciales              → la DB rechaza el imposible
-- Si la capa 2 se escribe mal algún día, la capa 3 lanza un error en vez de
-- despachar dos ambulancias al mismo sitio.
-- ============================================================================

-- Un vehículo no puede tener DOS asignaciones vivas. Nunca.
CREATE UNIQUE INDEX ux_one_active_assignment_per_vehicle
  ON assignments(vehicle_id)
  WHERE status IN ('OFFERED','ACCEPTED','EN_ROUTE','ON_SCENE','TRANSPORTING');

-- Un incidente no puede tener DOS asignaciones vivas.
-- (Multi-unidad para incidentes masivos es post-MVP: requerirá reemplazar este
--  índice por uno sobre (incident_id, role) — cambio de contrato, vía Athena.)
CREATE UNIQUE INDEX ux_one_active_assignment_per_incident
  ON assignments(incident_id)
  WHERE status IN ('OFFERED','ACCEPTED','EN_ROUTE','ON_SCENE','TRANSPORTING');

-- Idempotencia de las acciones mutadoras (§15).
CREATE UNIQUE INDEX ux_assignment_idempotency
  ON assignments(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Un vehículo no puede tener dos turnos abiertos.
CREATE UNIQUE INDEX ux_one_open_shift_per_vehicle
  ON shifts(vehicle_id) WHERE ended_at IS NULL;

-- Un mismo vehículo no puede aparecer dos veces en la misma corrida del motor.
CREATE UNIQUE INDEX ux_candidate_per_run_vehicle
  ON dispatch_candidates(dispatch_run_id, vehicle_id);

-- ─── Índices de lectura del camino caliente ─────────────────────────────────

-- El motor escanea incidentes vivos, no el histórico.
CREATE INDEX ix_incidents_live ON incidents(status)
  WHERE status NOT IN ('COMPLETED','CANCELLED','DUPLICATE');

-- Deduplicación (A1): busca incidentes recientes cerca. Con ~cientos de filas
-- el filtro por tiempo basta; el haversine se hace en JS sobre ese subconjunto.
CREATE INDEX ix_incidents_created_at ON incidents(created_at);
CREATE INDEX ix_incident_reports_incident ON incident_reports(incident_id);

-- Selección de candidatos (A3): parte de los vehículos despachables.
CREATE INDEX ix_vehicles_status ON vehicles(status);
CREATE INDEX ix_vehicles_zone ON vehicles(operating_zone_id);

-- Timeline (A4) y auditoría.
CREATE INDEX ix_incident_events_incident ON incident_events(incident_id, created_at);

-- Vista del responder: "¿tengo algo asignado?"
CREATE INDEX ix_assignments_vehicle_status ON assignments(vehicle_id, status);
CREATE INDEX ix_assignments_incident ON assignments(incident_id);

-- Barrido de ofertas vencidas (job de timeout de A3).
CREATE INDEX ix_assignments_expiry ON assignments(expires_at) WHERE status = 'OFFERED';

-- GPS obsoleto: el motor penaliza ubicaciones viejas en vez de confiar ciegamente.
CREATE INDEX ix_vehicle_current_location_recorded ON vehicle_current_location(recorded_at);

-- ─── Guardas append-only sobre la auditoría (§12) ───────────────────────────
-- La tabla de eventos es inmutable. Si alguien intenta reescribir la historia,
-- la base de datos lo impide en vez de confiar en la disciplina del equipo.

CREATE TRIGGER trg_incident_events_no_update
BEFORE UPDATE ON incident_events
BEGIN
  SELECT RAISE(ABORT, 'incident_events es append-only: UPDATE prohibido');
END;

CREATE TRIGGER trg_incident_events_no_delete
BEFORE DELETE ON incident_events
BEGIN
  SELECT RAISE(ABORT, 'incident_events es append-only: DELETE prohibido');
END;

CREATE TRIGGER trg_vehicle_locations_no_update
BEFORE UPDATE ON vehicle_locations
BEGIN
  SELECT RAISE(ABORT, 'vehicle_locations es append-only: UPDATE prohibido');
END;
