export const ASSIGNMENT_GONE_MESSAGE = 'Esta asignación ya no está disponible';

export type AssignmentActionOutcome =
  | { kind: 'ok' }
  | { kind: 'conflict'; message: typeof ASSIGNMENT_GONE_MESSAGE }
  | { kind: 'error' };

export function assignmentActionOutcome(status: number): AssignmentActionOutcome {
  if (status === 409) return { kind: 'conflict', message: ASSIGNMENT_GONE_MESSAGE };
  if (status >= 200 && status < 300) return { kind: 'ok' };
  return { kind: 'error' };
}
