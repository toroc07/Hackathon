import { zCitizenRegisterRequest, zCitizenRegisterResponse } from '@dispatch/contracts';
import { apiErrorResponse, HttpError } from '@/src/server/infra/errors';
import { citizenSessionCookie } from '@/src/server/infra/citizenSession';
import { registerCitizen } from '@/src/server/modules/citizens';

export const dynamic = 'force-dynamic';

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'VALIDATION_FAILED', 'El cuerpo debe ser JSON válido');
  }
}

/**
 * POST /api/citizens/register — nombre + correo + teléfono, sin contraseña.
 * El teléfono es lo que permite al responder llamar al ciudadano si un
 * reporte no trae suficiente información (ver ResponderClient).
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const input = zCitizenRegisterRequest.parse(await readJson(request));
    const citizen = await registerCitizen(input);
    return Response.json(zCitizenRegisterResponse.parse({ citizen }), {
      status: 201,
      headers: { 'Set-Cookie': citizenSessionCookie(citizen) },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
