-- ============================================================================
-- 002_constraints.sql — indices y guardas que HACEN CUMPLIR la correccion.
-- PostgreSQL.
--
-- Esto NO es optimizacion. Es la ultima linea de defensa contra el riesgo #1
-- del producto: dos incidentes quedandose con la misma ambulancia.
--
-- Con SQLite teniamos un unico escritor por proceso, lo que hacia casi
-- imposible intercalar dos asignaciones. Postgres SI permite escrituras
-- concurrentes reales desde multiples instancias serverless, asi que estos
-- indices pasan de ser una red de seguridad a ser el mecanismo principal.
--
-- Defensa en profundidad:
--   1. UPDATE condicional (... WHERE status='AVAILABLE') toma la fila y la
--      bloquea; el segundo escritor espera y luego ve 0 filas afectadas.
--   2. Estos indices unicos parciales rechazan el estado imposible aunque la
--      capa 1 se escriba mal algun dia.
-- ============================================================================

-- Un vehiculo no puede tener DOS asignaciones vivas. Nunca.
CREATE UNIQUE INDEX ux_one_active_assignment_per_vehicle
  ON assignments(vehicle_id)
  WHERE status IN ('OFFERED','ACCEPTED','EN_ROUTE','ON_SCENE','TRANSPORTING');

-- Un incidente no puede tener DOS asignaciones vivas.
CREATE UNIQUE INDEX ux_one_active_assignment_per_incident
  ON assignments(incident_id)
  WHERE status IN ('OFFERED','ACCEPTED','EN_ROUTE','ON_SCENE','TRANSPORTING');

-- Idempotencia de acciones mutadoras: un doble toque en un celular en
-- movimiento no puede crear dos asignaciones ni dos reportes.
CREATE UNIQUE INDEX ux_assignment_idempotency
  ON assignments(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX ux_incident_report_idempotency
  ON incident_reports(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX ux_one_open_shift_per_vehicle
  ON shifts(vehicle_id) WHERE ended_at IS NULL;

CREATE UNIQUE INDEX ux_candidate_per_run_vehicle
  ON dispatch_candidates(dispatch_run_id, vehicle_id);

-- ─── Indices del camino caliente ────────────────────────────────────────────

CREATE INDEX ix_incidents_live ON incidents(status)
  WHERE status NOT IN ('COMPLETED','CANCELLED','DUPLICATE');

CREATE INDEX ix_incidents_created_at ON incidents(created_at);
CREATE INDEX ix_incident_reports_incident ON incident_reports(incident_id);
CREATE INDEX ix_vehicles_status ON vehicles(status);
CREATE INDEX ix_vehicles_zone ON vehicles(operating_zone_id);
CREATE INDEX ix_incident_events_incident ON incident_events(incident_id, created_at);
CREATE INDEX ix_assignments_vehicle_status ON assignments(vehicle_id, status);
CREATE INDEX ix_assignments_incident ON assignments(incident_id);
CREATE INDEX ix_assignments_expiry ON assignments(expires_at) WHERE status = 'OFFERED';
CREATE INDEX ix_vehicle_current_location_recorded ON vehicle_current_location(recorded_at);
CREATE INDEX ix_vehicle_locations_vehicle_recorded
  ON vehicle_locations(vehicle_id, recorded_at DESC, id DESC);

-- ─── Guardas append-only sobre la auditoria ─────────────────────────────────
-- La historia de un incidente es inmutable. Si alguien intenta reescribirla,
-- la base de datos lo impide en vez de confiar en la disciplina del equipo.

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% es append-only: % prohibido', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_incident_events_no_update
  BEFORE UPDATE ON incident_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER trg_incident_events_no_delete
  BEFORE DELETE ON incident_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER trg_vehicle_locations_no_update
  BEFORE UPDATE ON vehicle_locations
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
