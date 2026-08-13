-- Idempotencia de la entrada ciudadana: una misma entrega nunca crea dos reportes.
ALTER TABLE incident_reports ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX ux_incident_report_idempotency
  ON incident_reports(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
