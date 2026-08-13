-- A3 dispatch: la explicación mostrada al operador se audita junto al desglose.
ALTER TABLE dispatch_candidates
  ADD COLUMN explanation TEXT NOT NULL DEFAULT '';

ALTER TABLE dispatch_runs
  ADD COLUMN recommendation_rationale TEXT;
