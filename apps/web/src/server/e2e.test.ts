/**
 * TEST DE INTEGRACIÓN END-TO-END.
 *
 * Recorre el criterio de éxito del MVP atravesando los CUATRO dominios que
 * construyeron agentes distintos e independientes:
 *
 *   ciudadano reporta -> reportes duplicados se agrupan -> el motor busca
 *   unidades -> calcula ETA -> evalúa cobertura -> recomienda -> se asigna
 *   exactamente UNA ambulancia -> la ambulancia acepta -> llega -> traslada
 *   -> el incidente se cierra -> todo queda auditado
 *
 * Si este test pasa, la demo funciona. Si falla, hay una costura rota entre
 * dominios que los tests unitarios de cada agente no pueden ver.
 *
 * Requiere un PostgreSQL accesible vía DATABASE_URL.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import type { IncidentType } from '@dispatch/contracts';
import { createIncidentFromReport, getIncidentDetail, listLiveIncidents } from './modules/incidents';
import {
  runDispatch, acceptAssignment, markEnRoute, markArrived,
  startTransport, completeAssignment,
} from './modules/dispatch';
import { db, closePool } from './infra/db';
import { runMigrations } from '@dispatch/db/migrations';
import { seedDatabase } from '@dispatch/db/seed';
import { isLocalPostgres } from './test-helpers';

const BOCAGRANDE = { lat: 10.4006, lng: -75.5560 };
const CRESPO = { lat: 10.4450, lng: -75.5130 };

/** Los 4 reportes del escenario: misma emergencia, 4 ciudadanos distintos. */
const REPORTES_DEL_MISMO_ACCIDENTE = [
  { lat: 10.4006, lng: -75.5560 },
  { lat: 10.4008, lng: -75.5558 },  // ~28 m
  { lat: 10.4004, lng: -75.5563 },  // ~41 m
  { lat: 10.4009, lng: -75.5555 },  // ~63 m
];

function reportar(
  point: { lat: number; lng: number },
  type: IncidentType = 'TRAFFIC_ACCIDENT',
) {
  return createIncidentFromReport({
    type,
    point,
    accuracyM: 25,
    description: 'Choque entre dos carros, hay heridos',
    patientCount: 2,
    source: 'WEB',
  });
}

describe.skipIf(!isLocalPostgres())('E2E — flujo completo de emergencia', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    // Estado limpio por test: la demo tiene que ser reproducible.
    //
    // La auditoría es append-only por trigger, así que ni siquiera este test
    // puede borrarla sin retirar la guarda primero. Es deliberado: el trigger
    // protege producción y aquí se restaura al terminar, para que ningún test
    // corra con la protección desactivada.
    const q = db();
    await q.exec(`
      DROP TRIGGER IF EXISTS trg_incident_events_no_delete ON incident_events;
      DROP TRIGGER IF EXISTS trg_vehicle_locations_no_update ON vehicle_locations;

      DELETE FROM incident_events;
      DELETE FROM assignments;
      DELETE FROM dispatch_candidates;
      DELETE FROM dispatch_runs;
      DELETE FROM incident_reports;
      DELETE FROM patients;
      DELETE FROM incidents;

      CREATE TRIGGER trg_incident_events_no_delete
        BEFORE DELETE ON incident_events
        FOR EACH ROW EXECUTE FUNCTION reject_mutation();
      CREATE TRIGGER trg_vehicle_locations_no_update
        BEFORE UPDATE ON vehicle_locations
        FOR EACH ROW EXECUTE FUNCTION reject_mutation();
    `);

    // Re-siembra la flota: deja el GPS fresco, que es lo que el motor exige
    // para no excluir las unidades por LOCATION_TOO_STALE.
    await seedDatabase();
  });

  it('4 reportes del mismo accidente producen 1 incidente y 1 sola asignación', async () => {
    const resultados = [];
    for (const p of REPORTES_DEL_MISMO_ACCIDENTE) resultados.push(await reportar(p));

    // LA TESIS DEL PRODUCTO: no 4 incidentes.
    const idsUnicos = new Set(resultados.map((r) => r.incident.id));
    expect(idsUnicos.size).toBe(1);

    // El primero crea; los otros tres se fusionan.
    expect(resultados[0]!.wasMerged).toBe(false);
    expect(resultados.slice(1).every((r) => r.wasMerged)).toBe(true);

    // 1 incidente, 4 reportes conservados (nunca se destruye el original).
    const detalle = await getIncidentDetail(resultados[0]!.incident.id);
    expect(detalle.reports).toHaveLength(4);
    expect(await listLiveIncidents()).toHaveLength(1);
  });

  it('emergencias de tipo incompatible cerca NO se fusionan', async () => {
    const trafico = await reportar(BOCAGRANDE, 'TRAFFIC_ACCIDENT');
    const cardiaco = await reportar({ lat: 10.4007, lng: -75.5559 }, 'CARDIAC');
    // Dos emergencias reales pueden ocurrir en la misma esquina.
    expect(cardiaco.incident.id).not.toBe(trafico.incident.id);
  });

  it('el motor recomienda con desglose explicable y excluye con motivo', async () => {
    const { incident } = await reportar(BOCAGRANDE);
    const resultado = await runDispatch(incident.id, { mode: 'RECOMMEND' });

    expect(resultado.candidates.length).toBeGreaterThan(0);
    expect(resultado.recommendedVehicleId).toBeTruthy();
    expect(resultado.recommendationRationale).toBeTruthy();

    // La aritmética del score tiene que cuadrar: es lo que se muestra en pantalla.
    for (const c of resultado.candidates) {
      const suma =
        c.etaSeconds + c.capabilityPenalty + c.coveragePenalty +
        c.workloadPenalty + c.staleLocationPenalty + c.operationalPenalty;
      expect(Math.round(suma)).toBe(Math.round(c.totalScore));
    }

    // Orden por score ascendente: el mejor primero.
    const scores = resultado.candidates.map((c) => c.totalScore);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);

    // Toda exclusión lleva motivo. Sin motivo, el despachador no confía.
    expect(resultado.excluded.every((e) => Boolean(e.excludedReason))).toBe(true);
  });

  it('ciclo completo: asignar → aceptar → en ruta → llegar → trasladar → cerrar, todo auditado', async () => {
    const { incident } = await reportar(BOCAGRANDE);
    const despacho = await runDispatch(incident.id, { mode: 'AUTO_ASSIGN' });

    const asignacion = despacho.assignment;
    expect(asignacion).toBeTruthy();
    expect(asignacion!.status).toBe('OFFERED');

    await acceptAssignment(asignacion!.id);
    await markEnRoute(asignacion!.id);
    await markArrived(asignacion!.id);
    await startTransport(asignacion!.id, { destinationFacilityId: null });
    await completeAssignment(asignacion!.id);

    const detalle = await getIncidentDetail(incident.id);
    expect(detalle.incident.status).toBe('COMPLETED');

    // Trazabilidad completa. Sin auditoría, un sistema de emergencias no se adopta.
    const tipos = detalle.events.map((e) => e.eventType);
    expect(tipos).toContain('INCIDENT_CREATED');
    expect(tipos).toContain('VEHICLE_ASSIGNED');
    expect(tipos).toContain('ASSIGNMENT_ACCEPTED');
    expect(tipos).toContain('INCIDENT_COMPLETED');
    expect(detalle.events.length).toBeGreaterThanOrEqual(6);
  });

  it('ESCENARIO B: el segundo incidente responde al nuevo estado de la flota', async () => {
    // Incidente 1 en Bocagrande, se lleva una unidad.
    const primero = await reportar(BOCAGRANDE);
    const d1 = await runDispatch(primero.incident.id, { mode: 'AUTO_ASSIGN' });
    const unidadTomada = d1.assignment!.vehicleId;
    await acceptAssignment(d1.assignment!.id);

    // Incidente 2 en Crespo, 30s después.
    const segundo = await reportar(CRESPO);
    const d2 = await runDispatch(segundo.incident.id, { mode: 'RECOMMEND' });

    // La unidad ocupada ya no puede ser candidata.
    expect(d2.candidates.map((c) => c.vehicleId)).not.toContain(unidadTomada);
    expect(d2.recommendedVehicleId).not.toBe(unidadTomada);
    expect(d2.recommendedVehicleId).toBeTruthy();
  });

  it('RIESGO #1: dos incidentes no pueden quedarse con la misma ambulancia', async () => {
    const a = await reportar(BOCAGRANDE);
    const b = await reportar(CRESPO);

    const da = await runDispatch(a.incident.id, { mode: 'AUTO_ASSIGN' });
    const dbResult = await runDispatch(b.incident.id, { mode: 'AUTO_ASSIGN' });

    expect(da.assignment).toBeTruthy();
    expect(dbResult.assignment).toBeTruthy();
    // Distinta unidad, siempre.
    expect(da.assignment!.vehicleId).not.toBe(dbResult.assignment!.vehicleId);
  });

  /**
   * Este test NO existía con SQLite y es el más importante de la migración.
   *
   * better-sqlite3 era síncrono y de un solo escritor: intercalar dos
   * asignaciones era casi imposible por construcción. Postgres permite
   * escrituras concurrentes reales desde varias instancias serverless, así que
   * la garantía de "una sola ambulancia" ahora depende del UPDATE condicional
   * y de los índices únicos parciales, no del motor.
   */
  it('CONCURRENCIA REAL: N despachos simultáneos sobre la misma flota no duplican unidad', async () => {
    const incidentes = [];
    for (let i = 0; i < 8; i += 1) {
      // Todos en el mismo punto: compiten por las mismas unidades cercanas.
      // Tipos alternados para que la deduplicación no los fusione.
      const tipo: IncidentType = i % 2 === 0 ? 'CARDIAC' : 'TRAUMA';
      incidentes.push(await reportar({ lat: 10.4006 + i * 0.004, lng: -75.5560 }, tipo));
    }

    // Despacho simultáneo: aquí es donde Postgres puede intercalar de verdad.
    const resultados = await Promise.all(
      incidentes.map((inc) =>
        runDispatch(inc.incident.id, { mode: 'AUTO_ASSIGN' }).catch(() => null),
      ),
    );

    const asignados = resultados
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((r) => r.assignment)
      .filter((a): a is NonNullable<typeof a> => a !== null);

    // Ninguna unidad puede aparecer dos veces.
    const vehiculos = asignados.map((a) => a.vehicleId);
    expect(new Set(vehiculos).size).toBe(vehiculos.length);

    // Y la base tiene que coincidir con lo que creemos.
    const filas = await db().many<{ vehicle_id: string; n: string }>(
      `SELECT vehicle_id, COUNT(*) AS n FROM assignments
       WHERE status IN ('OFFERED','ACCEPTED','EN_ROUTE','ON_SCENE','TRANSPORTING')
       GROUP BY vehicle_id HAVING COUNT(*) > 1`,
    );
    expect(filas).toHaveLength(0);
  });
});
