-- Registro de ciudadanos (nombre, correo, telefono) y de ambulancias
-- (placa, hospital) para el flujo de login pedido por el equipo.
--
-- El telefono del ciudadano es lo que permite al responder llamarlo desde
-- el panel de la ambulancia cuando un reporte no trae suficiente info.

CREATE TABLE citizens (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT NOT NULL,
  created_at  BIGINT NOT NULL
);

CREATE UNIQUE INDEX ux_citizens_email ON citizens(lower(email));
CREATE UNIQUE INDEX ux_citizens_phone ON citizens(phone);

ALTER TABLE vehicles
  ADD COLUMN plate                TEXT,
  ADD COLUMN hospital_facility_id TEXT;

CREATE UNIQUE INDEX ux_vehicles_plate ON vehicles(plate) WHERE plate IS NOT NULL;
