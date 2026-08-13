import Database from 'better-sqlite3';
import {
  MOCK_INCIDENT,
  MOCK_NOW,
  MOCK_REPORTS,
  TRIAGE_RULES,
  triage,
  type CreateIncidentRequest,
  type Incident,
  type IncidentType,
  type TriageSignals,
} from '@dispatch/contracts';
import { runMigrations, type SqliteDatabase } from '@dispatch/db';
import { afterEach, describe, expect, it } from 'vitest';
import {
  areIncidentTypesCompatible,
  createIncidentFromReport,
  decideDeduplication,
  getIncidentDetail,
} from './index';

const databases: SqliteDatabase[] = [];

function memoryDatabase(): SqliteDatabase {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function request(type: IncidentType, lat: number, lng: number, accuracyM = 20): CreateIncidentRequest {
  return { type, point: { lat, lng }, accuracyM, patientCount: 1, source: 'SIM', signals: {} };
}

describe('incident engine', () => {
  it('agrupa los cuatro reportes del escenario en un incidente sin perder reportes', () => {
    const db = memoryDatabase();
    const results = MOCK_REPORTS.map((report, index) => createIncidentFromReport(
      request('TRAFFIC_ACCIDENT', report.lat, report.lng, report.accuracyM ?? 0),
      { db, now: report.createdAt, idempotencyKey: `scenario-${index}` },
    ));

    expect(new Set(results.map((result) => result.incident.id)).size).toBe(1);
    expect(db.prepare('SELECT COUNT(*) count FROM incidents').get()).toMatchObject({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) count FROM incident_reports').get()).toMatchObject({ count: 4 });
    expect(results.map((result) => result.wasMerged)).toEqual([false, true, true, true]);
    expect(getIncidentDetail(results[0]!.incident.id, db).reports).toHaveLength(4);
  });

  it('no fusiona dos tipos incompatibles separados por cerca de 100 metros', () => {
    const db = memoryDatabase();
    createIncidentFromReport(request('TRAFFIC_ACCIDENT', 10.4006, -75.5560), { db, now: MOCK_NOW, idempotencyKey: 'incompatible-1' });
    const cardiac = createIncidentFromReport(request('CARDIAC', 10.4015, -75.5560), { db, now: MOCK_NOW + 30_000, idempotencyKey: 'incompatible-2' });

    expect(cardiac.wasMerged).toBe(false);
    expect(db.prepare('SELECT COUNT(*) count FROM incidents').get()).toMatchObject({ count: 2 });
  });

  it('trata un GPS muy impreciso como sugerencia, no como autorización para fusionar', () => {
    const candidate: Incident = { ...MOCK_INCIDENT, createdAt: MOCK_NOW };
    const decision = decideDeduplication({
      type: 'TRAFFIC_ACCIDENT', point: { lat: 10.4033, lng: -75.5560 },
      accuracyM: 300, createdAt: MOCK_NOW + 60_000,
    }, [candidate]);
    expect(decision.kind).toBe('SUGGEST');
  });

  it('reutiliza el mismo reporte cuando se repite Idempotency-Key', () => {
    const db = memoryDatabase();
    const first = createIncidentFromReport(request('TRAUMA', 10.4006, -75.5560), { db, now: MOCK_NOW, idempotencyKey: 'same-delivery' });
    const second = createIncidentFromReport(request('TRAUMA', 10.4020, -75.5540), { db, now: MOCK_NOW + 20_000, idempotencyKey: 'same-delivery' });
    expect(second.report.id).toBe(first.report.id);
    expect(db.prepare('SELECT COUNT(*) count FROM incident_reports').get()).toMatchObject({ count: 1 });
  });
});

describe('matriz explícita de compatibilidad', () => {
  it('acepta accidente de tránsito con trauma en ambas direcciones', () => {
    expect(areIncidentTypesCompatible('TRAFFIC_ACCIDENT', 'TRAUMA')).toBe(true);
    expect(areIncidentTypesCompatible('TRAUMA', 'TRAFFIC_ACCIDENT')).toBe(true);
  });

  it('rechaza evento cardíaco con accidente de tránsito', () => {
    expect(areIncidentTypesCompatible('CARDIAC', 'TRAFFIC_ACCIDENT')).toBe(false);
  });
});

const TRIAGE_CASES: ReadonlyArray<[string, IncidentType, TriageSignals]> = [
  ['R01_NOT_BREATHING', 'OTHER', { patientCount: 1, notBreathing: true }],
  ['R02_CARDIAC', 'CARDIAC', { patientCount: 1 }],
  ['R03_UNCONSCIOUS', 'OTHER', { patientCount: 1, unconscious: true }],
  ['R04_SEVERE_BLEEDING', 'OTHER', { patientCount: 1, severeBleeding: true }],
  ['R05_TRAPPED', 'OTHER', { patientCount: 1, trapped: true }],
  ['R06_MASS_CASUALTY', 'OTHER', { patientCount: 3 }],
  ['R07_TRAFFIC_MULTI', 'TRAFFIC_ACCIDENT', { patientCount: 2 }],
  ['R08_TRAFFIC', 'TRAFFIC_ACCIDENT', { patientCount: 1 }],
  ['R09_RESPIRATORY', 'RESPIRATORY', { patientCount: 1 }],
  ['R10_OBSTETRIC', 'OBSTETRIC', { patientCount: 1 }],
  ['R11_TRAUMA', 'TRAUMA', { patientCount: 1 }],
  ['R12_FALL', 'FALL', { patientCount: 1 }],
  ['R99_DEFAULT', 'OTHER', { patientCount: 1 }],
];

describe('cada fila contractual de triage', () => {
  it('mantiene una fila de prueba por cada regla publicada', () => {
    expect(TRIAGE_CASES.map(([id]) => id)).toEqual(TRIAGE_RULES.map((rule) => rule.id));
  });

  it.each(TRIAGE_CASES)('%s', (ruleId, type, signals) => {
    expect(triage(type, signals).ruleId).toBe(ruleId);
  });
});
