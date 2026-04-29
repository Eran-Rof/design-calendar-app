-- Compound index for the wholesale-forecast paginated read.
--
-- listForecast() filters by planning_run_id and orders by id (PK) for a
-- stable cursor across 1000-row pages. The existing single-column index
-- on planning_run_id (idx_ip_wf_run) gets us the filter but the sort
-- still falls back to an in-memory sort once the matched set passes a
-- few thousand rows — that's what was tripping the 8-second statement
-- timeout from PostgREST.
--
-- A compound (planning_run_id, id) lets Postgres do an indexed range
-- scan in id order for the matching planning_run_id, no sort step.

CREATE INDEX IF NOT EXISTS idx_ip_wf_run_id
  ON ip_wholesale_forecast (planning_run_id, id);

-- Same shape for the recommendations table, which the grid also reads
-- per planning_run_id and which has the same growth pattern.
CREATE INDEX IF NOT EXISTS idx_ip_wr_run_id
  ON ip_wholesale_recommendations (planning_run_id, id);
