import type { AssignmentStatus, IncidentStatus, VehicleStatus } from '@dispatch/contracts';
import { Badge } from './Badge';

type Status = IncidentStatus | VehicleStatus | AssignmentStatus;

const success = new Set<Status>(['AVAILABLE', 'COMPLETED']);
const danger = new Set<Status>(['P1' as Status, 'NO_RESOURCE', 'OUT_OF_SERVICE', 'CANCELLED']);
const warning = new Set<Status>(['REPORTED', 'VALIDATING', 'OPEN', 'ASSIGNING', 'OFFERED', 'RESERVED', 'UNAVAILABLE']);

export function StatusPill({ status, className = '' }: { status: Status; className?: string }) {
  const tone = success.has(status) ? 'success' : danger.has(status) ? 'danger' : warning.has(status) ? 'warning' : 'info';
  return <Badge tone={tone} className={className}>{status.replaceAll('_', ' ')}</Badge>;
}
