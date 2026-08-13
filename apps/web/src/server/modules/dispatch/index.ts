import type { DispatchRequest, RejectReason } from '@dispatch/contracts';
import {
  accept, arrive, assign, complete, enRoute, executeDispatch, getPersistedCandidates,
  rejectAndRedispatch, transport, type DispatchOptions,
} from './internal/engine';
import { expireOffers } from './internal/timeout';

export const runDispatch = (incidentId: string, request: DispatchRequest, options?: DispatchOptions) => executeDispatch(incidentId, request, options);
export const assignVehicle = assign;
export const acceptAssignment = accept;
export const rejectAssignment = (id: string, reason: RejectReason, options?: DispatchOptions) => rejectAndRedispatch(id, reason, options);
export const markEnRoute = enRoute;
export const markArrived = arrive;
export const startTransport = (
  id: string,
  destination: string | { destinationFacilityId: string | null },
  options?: DispatchOptions,
) => transport(id, typeof destination === 'string' ? destination : destination.destinationFacilityId, options);
export const completeAssignment = complete;
export async function expireStaleOffers(options: DispatchOptions = {}) {
  const expired = await expireOffers(options);
  return Promise.all(expired.map(async (assignment) => ({
    assignment,
    dispatch: await executeDispatch(assignment.incidentId, { mode: 'AUTO_ASSIGN', excludeVehicleIds: [assignment.vehicleId] }, { ...options, triggeredBy: 'TIMEOUT' }),
  })));
}
export const getCandidates = getPersistedCandidates;
