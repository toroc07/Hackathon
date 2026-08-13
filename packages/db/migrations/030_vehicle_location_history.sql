-- A2: consulta eficiente de la muestra histórica más reciente por vehículo.
CREATE INDEX ix_vehicle_locations_vehicle_recorded
  ON vehicle_locations(vehicle_id, recorded_at DESC, id DESC);
