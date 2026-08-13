-- Reporte por voz: el ciudadano graba en vez de llenar un formulario.
-- Rango 020-029 (dominio incidentes).

ALTER TABLE incident_reports
  -- Audio en base64. Se guarda junto al reporte porque ES evidencia del
  -- incidente y permite reprocesar la transcripcion si mejoramos el modelo.
  -- Tope aplicado en la capa de aplicacion (2 MB, ~60s de opus).
  ADD COLUMN audio_base64      TEXT,
  ADD COLUMN audio_mime_type   TEXT,
  ADD COLUMN audio_duration_s  DOUBLE PRECISION,
  ADD COLUMN transcript        TEXT,
  ADD COLUMN transcript_lang   TEXT,
  -- Confianza de la transcripcion. Por debajo del umbral, la UI pide al
  -- ciudadano que confirme el tipo con botones en vez de asumir que se
  -- entendio bien.
  ADD COLUMN transcript_confidence DOUBLE PRECISION,
  -- Que motor lo proceso. Si mañana cambiamos de proveedor hay que poder
  -- saber que reportes se procesaron con cual.
  ADD COLUMN transcript_engine TEXT,
  -- Referencia hablada de ubicacion ("frente al Exito de Bocagrande").
  -- No sustituye al GPS; ayuda al operador a confirmarlo.
  ADD COLUMN location_hint     TEXT;

-- Token opaco de seguimiento: permite al ciudadano ver su incidente sin login
-- y sin poder enumerar los de otros (a diferencia del codigo INC-482, que es
-- corto y adivinable).
ALTER TABLE incidents
  ADD COLUMN tracking_token TEXT;

CREATE UNIQUE INDEX ux_incidents_tracking_token
  ON incidents(tracking_token) WHERE tracking_token IS NOT NULL;

-- Marca de revision humana: se activa cuando la transcripcion tuvo baja
-- confianza. El centro de mando los destaca para que un operador confirme.
ALTER TABLE incidents
  ADD COLUMN needs_review BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX ix_incidents_needs_review ON incidents(needs_review)
  WHERE needs_review = TRUE;
