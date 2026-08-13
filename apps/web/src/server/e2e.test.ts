/**
 * TEST DE INTEGRACIÓN END-TO-END.
 *
 * Recorre el criterio de éxito del MVP (§34) atravesando los CUATRO dominios
 * que construyeron agentes distintos e independientes:
 *
 *   ciudadano reporta -> reportes duplicados se agrupan -> el motor busca
 *   unidades -> calcula ETA -> evalúa cobertura -> recomienda -> se asigna
 *   exactamente UNA ambulancia -> la ambulancia acepta -> llega -> traslada
 *   -> el incidente se cierra -> todo queda auditado
 *
 * Si este test pasa, la demo funciona. Si falla, hay una costura rota entre
 * dominios que los tests unitarios de cada agente no pueden ver.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { IncidentType } from '@dispatch/contracts';
import { createIncidentFromReport, getIncidentDetail, listLiveIncidents } from './modules/incidents';
import {
  runDispatch, acceptAssignment, markEnRoute, markArrived,
  startTransport, completeAssignment,
} from './modules/dispatch';
import { getDatabase } from './infra/db';

const BOCAGRANDE = { lat: 10.4006, lng: -75.5560 };

/** Los 4 reportes del escenario §22: misma emergencia, 4 ciudadanos. */
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

describe('E2E — flujo completo de emergencia', () => {
  beforeEach(() => {
    // Estado limpio por test: la demo tiene que ser reproducible.
    //
    // La auditoría es append-only por trigger (002_constraints.sql), así que ni
    // siquiera este test puede borrarla sin retirar la guarda primero. Eso es
    // deliberado: el trigger protege producción, y aquí se restaura al final
    // para que ningún test corra con la protección desactivada.
    const db = getDatabase();
    db.exec(`
      DROP TRIGGER IF EXISTS trg_incident_events_no_delete;
      DROP TRIGGER IF EXISTS trg_vehicle_locations_no_update;
      DELETE FROM incident_events;
      DELETE FROM assignments;
      DELETE FROM dispatch_candidates;
      DELETE FROM dispatch_runs;
      DELETE FROM incident_reports;
      DELETE FROM incidents;
      UPDATE vehicles SET status='AVAILABLE', current_assignment_id=NULL;

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
    `);
  });

  it('4 reportes del mismo accidente producen 1 incidente y 1 sola asignación', () => {
    const resultados = REPORTES_DEL_MISMO_ACCIDENTE.map((p) => reportar(p));

    // LA TESIS DEL PRODUCTO: no 4 incidentes.
    const idsUnicos = new Set(resultados.map((r) => r.incident.id));
    expect(idsUnicos.size).toBe(1);

    // El primero crea; los otros tres se fusionan.
    expect(resultados[0]!.wasMerged).toBe(false);
    expect(resultados.slice(1).every((r) => r.wasMerged)).toBe(true);

    // 1 incidente, 4 reportes conservados (nunca se destruye el original).
    const detalle = getIncidentDetail(resultados[0]!.incident.id);
    expect(detalle.reports).toHaveLength(4);
    expect(listLiveIncidents()).toHaveLength(1);
  });

  it('emergencias de tipo incompatible cerca NO se fusionan', () => {
    const trafico = reportar(BOCAGRANDE, 'TRAFFIC_ACCIDENT');
    const cardiaco = reportar({ lat: 10.4007, lng: -75.5559 }, 'CARDIAC');
    // Dos emergencias reales pueden ocurrir en la misma esquina.
    expect(cardiaco.incident.id).not.toBe(trafico.incident.id);
  });

  it('el motor recomienda con desglose explicable y excluye con motivo', () => {
    const { incident } = reportar(BOCAGRANDE);
    const resultado = runDispatch(incident.id, { mode: 'RECOMMEND' });

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

  it('ciclo completo: asignar → aceptar → en ruta → llegar → trasladar → cerrar, todo auditado', () => {
    const { incident } = reportar(BOCAGRANDE);
    const despacho = runDispatch(incident.id, { mode: 'AUTO_ASSIGN' });

    const asignacion = despacho.assignment;
    expect(asignacion).toBeTruthy();
    expect(asignacion!.status).toBe('OFFERED');

    acceptAssignment(asignacion!.id);
    markEnRoute(asignacion!.id);
    markArrived(asignacion!.id);
    startTransport(asignacion!.id, { destinationFacilityId: null });
    completeAssignment(asignacion!.id);

    const detalle = getIncidentDetail(incident.id);
    expect(detalle.incident.status).toBe('COMPLETED');

    // §12: trazabilidad completa. Sin esto no hay auditoría, y sin auditoría
    // un sistema de emergencias no se adopta.
    const tipos = detalle.events.map((e) => e.eventType);
    expect(tipos).toContain('INCIDENT_CREATED');
    expect(tipos).toContain('VEHICLE_ASSIGNED');
    expect(tipos).toContain('ASSIGNMENT_ACCEPTED');
    expect(tipos).toContain('INCIDENT_COMPLETED');
    expect(detalle.events.length).toBeGreaterThanOrEqual(6);
  });

  it('ESCENARIO B: el segundo incidente responde al nuevo estado de la flota', () => {
    // Incidente 1 en Bocagrande, se lleva una unidad.
    const primero = reportar(BOCAGRANDE);
    const d1 = runDispatch(primero.incident.id, { mode: 'AUTO_ASSIGN' });
    const unidadTomada = d1.assignment!.vehicleId;
    acceptAssignment(d1.assignment!.id);

    // Incidente 2 en Crespo, 30s después.
    const segundo = reportar({ lat: 10.4450, lng: -75.5130 });
    const d2 = runDispatch(segundo.incident.id, { mode: 'RECOMMEND' });

    // La unidad ocupada ya no puede ser candidata.
    expect(d2.candidates.map((c) => c.vehicleId)).not.toContain(unidadTomada);
    expect(d2.recommendedVehicleId).not.toBe(unidadTomada);
    expect(d2.recommendedVehicleId).toBeTruthy();
  });

  it('RIESGO #1: dos incidentes no pueden quedarse con la misma ambulancia', () => {
    const a = reportar(BOCAGRANDE);
    const b = reportar({ lat: 10.4450, lng: -75.5130 });

    const da = runDispatch(a.incident.id, { mode: 'AUTO_ASSIGN' });
    const db_ = runDispatch(b.incident.id, { mode: 'AUTO_ASSIGN' });

    expect(da.assignment).toBeTruthy();
    expect(db_.assignment).toBeTruthy();
    // Distinta unidad, siempre.
    expect(da.assignment!.vehicleId).not.toBe(db_.assignment!.vehicleId);
  });
});
