import {
  zDispatchResponse,
  zIncidentDetailResponse,
  type ApiError,
  type DispatchResponse,
  type IncidentEvent,
} from '@dispatch/contracts';

export class CommandApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CommandApiError';
  }
}

async function apiJson(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const response = await fetch(input, { cache: 'no-store', ...init });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const apiError = payload as ApiError | null;
    throw new CommandApiError(
      apiError?.error?.message ?? `El servidor respondió HTTP ${response.status}`,
      response.status,
      apiError?.error?.code,
    );
  }

  return payload;
}

export async function fetchDispatchCandidates(incidentId: string): Promise<DispatchResponse> {
  return zDispatchResponse.parse(await apiJson(`/api/incidents/${incidentId}/candidates`));
}

export async function fetchIncidentEvents(incidentId: string): Promise<IncidentEvent[]> {
  const detail = zIncidentDetailResponse.parse(await apiJson(`/api/incidents/${incidentId}`));
  return detail.events;
}

export async function assignVehicle(
  incidentId: string,
  vehicleId?: string,
): Promise<DispatchResponse> {
  const body = vehicleId
    ? { mode: 'AUTO_ASSIGN' as const, overrideVehicleId: vehicleId }
    : { mode: 'AUTO_ASSIGN' as const };

  return zDispatchResponse.parse(await apiJson(`/api/incidents/${incidentId}/dispatch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  }));
}
