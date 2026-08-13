import { zRegisterVehicleRequest, zRegisterVehicleResponse } from '@dispatch/contracts';
import { apiErrorResponse, HttpError } from '@/src/server/infra/errors';
import { registerVehicle } from '@/src/server/modules/vehicles';

export const dynamic = 'force-dynamic';

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'VALIDATION_FAILED', 'El cuerpo debe ser JSON válido');
  }
}

/** POST /api/vehicles/register — alta de ambulancia: placa + unidad + hospital (§33). */
export async function POST(request: Request): Promise<Response> {
  try {
    const input = zRegisterVehicleRequest.parse(await readJson(request));
    const result = await registerVehicle(input);
    return Response.json(zRegisterVehicleResponse.parse(result), { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
