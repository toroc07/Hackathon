import { getActiveAssignmentForVehicle, getVehicle } from '@/src/server/modules/vehicles';
import { getPrimaryReportContact } from '@/src/server/modules/incidents';
import { apiErrorResponse } from '@/src/server/infra/errors';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    const [vehicle, activeAssignment] = await Promise.all([
      getVehicle(id),
      getActiveAssignmentForVehicle(id),
    ]);
    // Para el botón "Llamar al ciudadano" del responder — null si el reporte
    // no dejó contacto, la UI simplemente no muestra el botón.
    const reporterContact = activeAssignment ? await getPrimaryReportContact(activeAssignment.incident.id) : null;
    return Response.json({ vehicle, activeAssignment, reporterContact });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
