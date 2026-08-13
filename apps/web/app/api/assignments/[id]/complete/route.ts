import { zAssignment, zCompleteAssignmentRequest } from '@dispatch/contracts';
import { completeAssignment } from '@/src/server/modules/dispatch';
import { dispatchApiError, optionalJson } from '@/app/api/dispatch/_shared';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    zCompleteAssignmentRequest.parse(await optionalJson(request));
    const { id } = await context.params;
    return Response.json(zAssignment.parse(await completeAssignment(id)));
  } catch (error) { return dispatchApiError(error); }
}
