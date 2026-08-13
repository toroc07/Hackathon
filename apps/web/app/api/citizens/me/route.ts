import { resolveCitizenSession } from '@/src/server/infra/citizenSession';

export const dynamic = 'force-dynamic';

/** GET /api/citizens/me — null si no hay sesión (el cliente decide si manda a /login). */
export async function GET(request: Request): Promise<Response> {
  return Response.json({ citizen: resolveCitizenSession(request) });
}
