import { apiErrorResponse } from '@/src/server/infra/errors';
import { getIncidentDetail, getPrimaryReportSummary, listLiveIncidents } from '@/src/server/modules/incidents';
import { UNIVERSAL_VEHICLE_ID } from '@/src/server/modules/vehicles';

export const dynamic = 'force-dynamic';

/**
 * GET /api/responder/current — el panel de ambulancia único (§ demo: una
 * sola unidad "universal", sin login ni selector). No importa dónde caiga el
 * reporte: siempre se sirve el incidente vivo más urgente/reciente, con su
 * asignación si el despacho automático ya corrió.
 */
export async function GET(): Promise<Response> {
  try {
    const live = await listLiveIncidents();
    const incident = live[0] ?? null;
    if (!incident) {
      return Response.json({
        incident: null, reportSummary: null, reporterContact: null,
        assignment: null, assignedVehicle: null, liveEtaSeconds: null,
        universalVehicleId: UNIVERSAL_VEHICLE_ID,
      });
    }
    const [detail, summary] = await Promise.all([
      getIncidentDetail(incident.id),
      getPrimaryReportSummary(incident.id),
    ]);
    return Response.json({
      incident: detail.incident,
      reportSummary: summary.description,
      reporterContact: summary.reporterContact,
      assignment: detail.assignment,
      assignedVehicle: detail.assignedVehicle,
      liveEtaSeconds: detail.liveEtaSeconds,
      universalVehicleId: UNIVERSAL_VEHICLE_ID,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
