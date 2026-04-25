export type AIDemandFlag =
  | "review_urgently"
  | "potential_stockout"
  | "excess_risk"
  | "suppressed_demand";

export type AIDemandDirection = "up" | "down" | "flat";

export interface AIDemandPrediction {
  sku_id: string;
  sku_code: string;
  predicted_qty: number;
  confidence_score: number;
  vs_current_forecast_pct: number | null;
  direction: AIDemandDirection;
  key_signals: string[];
  market_factors: string[];
  flag: AIDemandFlag | null;
  rationale: string;
}

export interface AIDemandResult {
  predictions: AIDemandPrediction[];
  context_summary: {
    run_name: string;
    snapshot_date: string;
    horizon: string;
    skus_analyzed: number;
    wholesale_txns: number;
    ecom_txns: number;
    model: string;
  };
  generated_at: string;
}
