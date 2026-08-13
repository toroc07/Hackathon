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
import type { Queryable } from '@dispatch/db';
import { describe, expect, it, vi } from 'vitest';
import {
  areIncidentTypesCompatible,
  createIncidentFromReport,
  decideDeduplication,
  getIncidentDetail,
} from './index';

type Row = Record<string, unknown>;

class MemoryQueryable implements Queryable {
  incidents: Row[] = [];
  reports: Row[] = [];
  events: Row[] = [];

  async one<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    let row: Row | undefined;
    if (normalized === 'select * from incidents where id = ?') {
      row = this.incidents.find((item) => item.id === params[0]);
    } else if (normalized === 'select * from incident_reports where idempotency_key = ?') {
      row = this.reports.find((item) => item.idempotency_key === params[0]);
    } else if (normalized.startsWith('select * from assignments where incident_id = ?')) {
      row = undefined;
    } else {
      throw new Error(`Consulta one no implementada: ${normalized}`);
    }
    return row as T | undefined;
  }

  async many<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    let rows: Row[];
    if (normalized.startsWith('select * from incidents where created_at >= ?')) {
      rows = this.incidents
        .filter((item) => (item.created_at as number) >= (params[0] as number)
          && !['COMPLETED', 'CANCELLED', 'DUPLICATE'].includes(item.status as string))
        .sort((a, b) => (b.created_at as number) - (a.created_at as number));
    } else if (normalized.startsWith('select * from incidents where status not in')) {
      rows = this.incidents.filter((item) => !['COMPLETED', 'CANCELLED', 'DUPLICATE'].includes(item.status as string));
    } else if (normalized.startsWith('select * from incident_reports where incident_id = ?')) {
      rows = this.reports
        .filter((item) => item.incident_id === params[0])
        .sort((a, b) => (a.created_at as number) - (b.created_at as number));
    } else if (normalized.startsWith('select * from incident_events where incident_id = ?')) {
      rows = this.events.filter((item) => item.incident_id === params[0]);
    } else {
      throw new Error(`Consulta many no implementada: ${normalized}`);
    }
    return rows as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.startsWith('insert into incidents ')) {
      const [id, code, status, type, lat, lng, patientCount, createdAt] = params;
      this.incidents.push({
        id, code, status, priority: null, type, lat, lng, address: null,
        patient_count: patientCount, required_capability: null, zone_id: null,
        primary_report_id: null, merged_into_incident_id: null, created_at: createdAt, closed_at: null,
      });
    } else if (normalized.startsWith('insert into incident_reports ')) {
      const [id, incidentId, source, reporterContact, description, lat, lng, accuracyM,
        wasMerged, mergeConfidence, mergeReason, createdAt, idempotencyKey] = params;
      this.reports.push({
        id, incident_id: incidentId, source, reporter_contact: reporterContact, description,
        lat, lng, accuracy_m: accuracyM, was_merged: wasMerged, merge_confidence: mergeConfidence,
        merge_reason: mergeReason, created_at: createdAt, idempotency_key: idempotencyKey,
      });
    } else if (normalized.startsWith('insert into incident_events ')) {
      const [id, incidentId, eventType, actorType, actorId, metadata, createdAt] = params;
      this.events.push({
        id, incident_id: incidentId, event_type: eventType, actor_type: actorType,
        actor_id: actorId, metadata, created_at: createdAt,
      });
    } else if (normalized === 'update incidents set status = ?, closed_at = ? where id = ?') {
      this.updateIncident(params[2], { status: params[0], closed_at: params[1] });
    } else if (normalized === 'update incidents set primary_report_id = ? where id = ?') {
      this.updateIncident(params[1], { primary_report_id: params[0] });
    } else if (normalized === 'update incidents set priority = ?, required_capability = ? where id = ?') {
      this.updateIncident(params[2], { priority: params[0], required_capability: params[1] });
    } else if (normalized.startsWith('update incidents set ')) {
      const incidentId = params.at(-1);
      const columns = normalized.slice('update incidents set '.length, normalized.indexOf(' where id = ?')).split(', ');
      this.updateIncident(incidentId, Object.fromEntries(columns.map((assignment, index) => {
        const column = assignment.split(' = ')[0];
        if (!column) throw new Error(`Asignación SQL inválida: ${assignment}`);
        return [column, params[index]];
      })));
    } else {
      throw new Error(`Consulta run no implementada: ${normalized}`);
    }
    return { changes: 1 };
  }

  async exec(): Promise<void> {}

  private updateIncident(id: unknown, changes: Row): void {
    const incident = this.incidents.find((item) => item.id === id);
    if (!incident) throw new Error(`Incidente inexistente: ${String(id)}`);
    Object.assign(incident, changes);
  }
}

const databaseState = vi.hoisted(() => ({
  current: null as Queryable | null,
  get(): Queryable {
    if (!this.current) throw new Error('No hay Queryable de prueba activo');
    return this.current;
  },
}));

vi.mock('@/src/server/infra/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/src/server/infra/db')>();
  return {
    ...original,
    db: () => databaseState.get(),
    tx: async <T>(fn: (q: Queryable) => Promise<T>) => fn(databaseState.get()),
  };
});

function memoryDatabase(): MemoryQueryable {
  const q = new MemoryQueryable();
  databaseState.current = q;
  return q;
}

function request(type: IncidentType, lat: number, lng: number, accuracyM = 20): CreateIncidentRequest {
  return { type, point: { lat, lng }, accuracyM, patientCount: 1, source: 'SIM', signals: {} };
}

describe('incident engine', () => {
  it('agrupa los cuatro reportes del escenario en un incidente sin perder reportes', async () => {
    const q = memoryDatabase();
    const results = [];
    for (const [index, report] of MOCK_REPORTS.entries()) {
      results.push(await createIncidentFromReport(
      request('TRAFFIC_ACCIDENT', report.lat, report.lng, report.accuracyM ?? 0),
      { now: report.createdAt, idempotencyKey: `scenario-${index}` },
      ));
    }

    expect(new Set(results.map((result) => result.incident.id)).size).toBe(1);
    expect(q.incidents).toHaveLength(1);
    expect(q.reports).toHaveLength(4);
    expect(results.map((result) => result.wasMerged)).toEqual([false, true, true, true]);
    const firstResult = results[0];
    if (!firstResult) throw new Error('El escenario no produjo resultados');
    expect((await getIncidentDetail(firstResult.incident.id, q)).reports).toHaveLength(4);
  });

  it('no fusiona dos tipos incompatibles separados por cerca de 100 metros', async () => {
    const q = memoryDatabase();
    await createIncidentFromReport(request('TRAFFIC_ACCIDENT', 10.4006, -75.5560), { now: MOCK_NOW, idempotencyKey: 'incompatible-1' });
    const cardiac = await createIncidentFromReport(request('CARDIAC', 10.4015, -75.5560), { now: MOCK_NOW + 30_000, idempotencyKey: 'incompatible-2' });

    expect(cardiac.wasMerged).toBe(false);
    expect(q.incidents).toHaveLength(2);
  });

  it('trata un GPS muy impreciso como sugerencia, no como autorización para fusionar', () => {
    const candidate: Incident = { ...MOCK_INCIDENT, createdAt: MOCK_NOW };
    const decision = decideDeduplication({
      type: 'TRAFFIC_ACCIDENT', point: { lat: 10.4033, lng: -75.5560 },
      accuracyM: 300, createdAt: MOCK_NOW + 60_000,
    }, [candidate]);
    expect(decision.kind).toBe('SUGGEST');
  });

  it('reutiliza el mismo reporte cuando se repite Idempotency-Key', async () => {
    const q = memoryDatabase();
    const first = await createIncidentFromReport(request('TRAUMA', 10.4006, -75.5560), { now: MOCK_NOW, idempotencyKey: 'same-delivery' });
    const second = await createIncidentFromReport(request('TRAUMA', 10.4020, -75.5540), { now: MOCK_NOW + 20_000, idempotencyKey: 'same-delivery' });
    expect(second.report.id).toBe(first.report.id);
    expect(q.reports).toHaveLength(1);
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
