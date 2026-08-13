import {
  triage,
  type IncidentPriority,
  type IncidentType,
  type TriageResult,
  type TriageSignals,
} from '@dispatch/contracts';

export interface TriageDecision extends TriageResult {
  overriddenByOperator: boolean;
}

export function applyTriage(
  type: IncidentType,
  signals: TriageSignals,
  operatorOverride?: IncidentPriority,
): TriageDecision {
  const result = triage(type, signals);
  return {
    ...result,
    priority: operatorOverride ?? result.priority,
    overriddenByOperator: operatorOverride !== undefined,
  };
}
