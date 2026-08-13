import { getActiveAssignmentForVehicle, getVehicle } from '@/src/server/modules/vehicles';
import { getPrimaryReportSummary } from '@/src/server/modules/incidents';
import { apiErrorResponse } from '@/src/server/infra/errors';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    const [vehicle, activeAssignment] = await Promise.all([
      getVehicle(id),
      getActiveAssignmentForVehicle(id),
    ]);
    // Reporte de la IA + contacto para llamar — null si no hay asignación o
    // el reporte no trajo el dato; la UI simplemente no muestra esa parte.
    const { description, reporterContact } = activeAssignment
      ? await getPrimaryReportSummary(activeAssignment.incident.id)
      : { description: null, reporterContact: null };
    return Response.json({ vehicle, activeAssignment, reportSummary: description, reporterContact });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
