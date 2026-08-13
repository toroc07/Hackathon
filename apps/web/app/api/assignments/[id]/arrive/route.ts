import { zAcceptAssignmentRequest, zAssignment } from '@dispatch/contracts';
import { markArrived } from '@/src/server/modules/dispatch';
import { dispatchApiError, optionalJson } from '@/app/api/dispatch/_shared';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    zAcceptAssignmentRequest.parse(await optionalJson(request));
    const { id } = await context.params;
    return Response.json(zAssignment.parse(markArrived(id)));
  } catch (error) { return dispatchApiError(error); }
}
