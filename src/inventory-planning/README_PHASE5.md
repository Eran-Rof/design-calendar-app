# Demand & Inventory Planning — Phase 5 (Forecast Accuracy + AI Augmentation)

Measures forecast quality against actuals, evaluates whether overrides
helped, surfaces anomalies, and offers explainable co-pilot suggestions.

All logic is **deterministic and rule-based first**. Every suggestion
and anomaly carries a rationale, the exact numbers that triggered it,
and a confidence score. There is no model-driven "black-box" replacement
forecast; suggestions are proposals a planner can accept, ignore, or
manually adjust.

## What ships

- **Migration** `supabase/migrations/20260419860000_inventory_planning_phase5.sql`:
  - `ip_forecast_actuals` — per-grain actual demand (wholesale monthly by customer, ecom weekly by channel)
  - `ip_forecast_accuracy` — per-grain error metrics (abs / pct / bias / weighted, system vs final vs actual)
  - `ip_override_effectiveness` — did the override help?
  - `ip_planning_anomalies` — rule-based anomaly log with confidence
  - `ip_ai_suggestions` — explainable suggestion rows with accept/ignore audit
  - `scenario_id` columns present but **no FK** yet — Phase 4 will add the constraint when the `scenarios` table lands (noted in a header comment on the migration)
- **Types** `src/inventory-planning/accuracy/types/accuracy.ts` and `src/inventory-planning/intelligence/types/intelligence.ts`
- **Compute** (all pure):
  - `accuracy/compute/accuracyMetrics.ts` — per-row metrics, override-helped, aggregates
  - `intelligence/compute/anomalyDetection.ts` — 9 anomaly detectors
  - `intelligence/compute/aiSuggestions.ts` — 8 suggestion types
- **Services**:
  - `accuracy/services/accuracyRepo.ts` — REST access for all 5 tables
  - `accuracy/services/accuracyService.ts` — `buildForecastActuals`, `calculateForecastAccuracy`, `runAccuracyAndIntelligencePass` orchestrator
- **UI** at `/planning/accuracy`:
  - `ForecastAccuracyDashboard` — stat cards + "top misses" grouped by SKU/category/customer/channel
  - `OverrideEffectivenessPanel` — helped/hurt/neutral by override reason + sample rows
  - `AnomalyQueue` — severity-ranked, filterable, "critical only" toggle
  - `AISuggestionPanel` — each suggestion with delta, target, confidence, rationale, accept/ignore
  - `AccuracyWorkbench` — parent tabs page
- **Tests** (3 new files, ~30 cases):
  - `accuracyMetrics.test.ts` — exact / over / under / divide-by-zero, WAPE aggregation
  - `anomalyDetection.test.ts` — every detector
  - `aiSuggestions.test.ts` — every suggestion path

## Metric definitions

Per row (visible in `ip_forecast_accuracy`):

| Column | Formula |
|---|---|
| `abs_error_system` | `|system_forecast_qty − actual_qty|` |
| `abs_error_final`  | `|final_forecast_qty − actual_qty|` |
| `pct_error_system` | `(system − actual) / actual`, or `null` if `actual = 0` |
| `pct_error_final`  | `(final − actual) / actual`, or `null` if `actual = 0` |
| `bias_system` | `system − actual` (signed; positive = overforecast) |
| `bias_final`  | `final − actual` |
| `weighted_error_system` | `abs_error_system × actual` |
| `weighted_error_final`  | `abs_error_final × actual` |

Aggregates shown in the dashboard:

- **MAE** = mean of `abs_error_*`
- **WAPE** = `Σ |forecast − actual| / Σ actual` (demand-weighted; robust to zero-demand rows)
- **Bias** = mean of signed bias
- **MAE Δ** = `mae_system − mae_final`. **Positive = overrides helped**. Shown on every grouped row and on the overall stat card.

Grains supported in the dashboard: SKU · category · customer · channel.
Lanes: wholesale / ecom / both.

## Override effectiveness logic

For every forecast row where `system_forecast_qty ≠ final_forecast_qty`:

- `error_delta = |system − actual| − |final − actual|`
- `override_helped_flag = true` when `error_delta > HELPED_EPSILON` (= 1)
- `override_helped_flag = false` when `error_delta < −HELPED_EPSILON`
- `override_helped_flag = null` for neutral / no-override / no-actual rows

Rollups by `override_reason`:
- helped / hurt / neutral counts
- average signed `error_delta` (positive → reason helped overall)

This gives planners a concrete answer to "do my 'buyer_request' overrides
actually help, on average?"

## Anomaly rules

Exported constants live in `anomalyDetection.ts`. All triggers emit a
`message` + `details_json` + confidence.

| Type | Rule |
|---|---|
| `demand_spike` | `actual ≥ SPIKE_MULTIPLIER × trailing_avg` (default 2.0×). |
| `demand_collapse` | `actual ≤ COLLAPSE_MULTIPLIER × trailing_avg` (default 0.25×). |
| `repeated_forecast_miss` | `REPEATED_MISS_STREAK` (3) consecutive periods with `|pct_error_final| > REPEATED_MISS_PCT` (25%). |
| `chronic_overbuy` | 3 consecutive periods with `bias_final > 25% of actual`. |
| `chronic_stockout` | 3 consecutive `projected_stockout_flag = true` rows in `ip_projected_inventory`. |
| `return_rate_spike` | Latest `return_rate ≥ RETURN_RATE_SPIKE` (40%). |
| `protected_repeatedly_uncovered` | 3 consecutive ecom periods where `protected_ecom_qty > final_forecast_qty`. |
| `buyer_request_conversion_miss` | `actual < 60% × requested` on a row with a buyer request. |
| `forecast_volatility` | Coefficient of variation of the last 6 final_forecast_qty values > `VOLATILITY_CV` (1.0). |

Severity ladder: critical / high / medium / low. Mapped from magnitude
(e.g. demand spike at ≥ 3× is `high`, otherwise `medium`).

## Suggestion types

Emitted by `aiSuggestions.ts`. Heuristic only — no model weights, no
training data dependency.

| Type | Trigger | Output |
|---|---|---|
| `increase_forecast` | Underforecasting trend over last `CONSISTENT_UNDER_STREAK` (3) periods. | `+delta` to land at recent trend; confidence scales with error magnitude. |
| `decrease_forecast` | Overforecasting trend over last 3 periods. | Negative delta. |
| `increase_confidence` | WAPE over last 4 periods < 10%. | Action-only (no qty). |
| `lower_confidence` | WAPE over last 4 periods > 40%. | Action-only. |
| `protect_more_inventory` | Protected ecom uncovered for 2+ consecutive periods. | +20% of current protected qty. |
| `reduce_buy_recommendation` | Reserved for Phase 6 — slot in the UI but not emitted yet. | — |
| `review_buyer_request` | Buyer request with no history OR ≥ 3× trailing avg. | Action-only. |
| `inspect_return_rate` | Return rate ≥ 35%. | Action-only. |

Every suggestion row carries:
- `rationale` (one sentence in plain English)
- `input_summary_json` (the exact numbers the heuristic saw)
- `confidence_score` (0..1; shown in the UI)
- `accepted_flag` (null until the planner clicks)

## Explainability approach

- **No hidden state.** Every detector / suggester is a pure function
  reading from persisted Phase 0–3 tables.
- **Every row is auditable.** `details_json` and `input_summary_json` are
  stored, not just displayed.
- **Thresholds are exported constants.** Tuning is a code review, not a
  configuration Ouija board.
- **Acceptance is stored.** When a planner accepts a suggestion, the
  `accepted_flag`, `accepted_by`, and `accepted_at` are persisted — so
  Phase 6 can learn which suggestion types planners actually trust.

## Data flow

```
Phase 0 history                    Phase 1/2 forecasts
 (ip_sales_history_*)               (ip_wholesale_forecast,
  │                                  ip_ecom_forecast)
  │                                   │
  ▼                                   ▼
buildForecastActuals           ip_planning_runs references
 → ip_forecast_actuals         (wholesale_source_run_id,
  │                             ecom_source_run_id)
  ▼                                   │
calculateForecastAccuracy  ──────────┘
 → ip_forecast_accuracy
 → ip_override_effectiveness
  │
  ▼
runAnomalyDetection           + Phase 3 supply context
 → ip_planning_anomalies       (ip_projected_inventory)
  │                             + ip_ecom_forecast return rate / protected
  ▼
AI suggestion generators
 → ip_ai_suggestions
```

## Known limitations

- **Phase 4 not built yet.** `scenario_id` columns are nullable uuid
  without a FK. When Phase 4 introduces `ip_scenarios`, add the FK per
  the header comment in the migration.
- **Ecom override reason isn't joined in effectiveness rows.** Phase 2's
  `ip_ecom_override_events` has the reason codes; Phase 5 MVP only pulls
  the wholesale override trail. Ecom `override_reason` fields are left
  null for now.
- **No per-planner rollup** (we don't have a real user layer yet — Phase
  0 memory notes the TandA JSON-blob user store). When real users land,
  `created_by` flows through and this becomes a 10-line addition.
- **No automatic learning.** Thresholds are hand-tuned. A Phase 6 could
  use accepted vs ignored suggestion history to auto-tune, but Phase 5
  deliberately stops at heuristics so the behavior stays reviewable.
- **AI suggestions do not patch forecasts on accept.** They record the
  acceptance — applying the delta to `final_forecast_qty` is a one-click
  action planned for Phase 6.
- **MAPE is not persisted.** WAPE covers the same ground in a
  divide-by-zero-safer way; MAPE can be computed on read with
  `|pct_error_final|` rows.

## Next-step opportunities (beyond Phase 5)

- Accept-a-suggestion → patch the underlying forecast with a new override
  event (reason = `ai_assisted`).
- Rolling accuracy tracker: store a backtest per scenario when Phase 4
  lands, compare scenarios side-by-side.
- Per-customer / per-planner performance cards once user identity is
  threaded through.
- Learned thresholds: the shape of every detector is
  `(signal, threshold) → anomaly`; swapping threshold constants for
  per-category learned values is mechanical once we have enough history.

## Running locally

1. Apply `supabase/migrations/20260419860000_inventory_planning_phase5.sql`
   (via `supabase db push --linked` with the usual park-then-restore for
   any unrelated pending migration).
2. `/planning/accuracy` → pick a run (the demo reconciliation run works
   great here because it already references wholesale + ecom sources) →
   **Run accuracy + intelligence pass**.
3. Flip through the four tabs: Accuracy · Overrides · Anomalies · Suggestions.
