import type {
  CapabilityLevel,
  IncidentStatus,
  VehicleStatus,
} from '@dispatch/contracts';

export interface IncidentRow {
  id: string;
  status: IncidentStatus;
  lat: number;
  lng: number;
  zone_id: string | null;
  required_capability: CapabilityLevel | null;
}

export interface VehicleRow {
  id: string;
  callsign: string;
  status: VehicleStatus;
  capability_level: CapabilityLevel;
  operating_zone_id: string | null;
  current_assignment_id: string | null;
  lat: number | null;
  lng: number | null;
  recorded_at: number | null;
  recent_jobs: number;
}

export interface ZoneRow {
  id: string;
  name: string;
  target_coverage_units: number;
  population_weight: number;
  available_units: number;
}
