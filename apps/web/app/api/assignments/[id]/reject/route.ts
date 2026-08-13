import { zAssignment, zRejectAssignmentRequest, zDispatchResponse } from '@dispatch/contracts';
import { rejectAssignment } from '@/src/server/modules/dispatch';
import { dispatchApiError, optionalJson } from '@/app/api/dispatch/_shared';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const input = zRejectAssignmentRequest.parse(await optionalJson(request));
    const { id } = await context.params;
    const result = rejectAssignment(id, input.reason, { idempotencyKey: request.headers.get('Idempotency-Key') });
    return Response.json({ assignment: zAssignment.parse(result.assignment), dispatch: zDispatchResponse.parse(result.dispatch) });
  } catch (error) { return dispatchApiError(error); }
}
