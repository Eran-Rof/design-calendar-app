// M31 / P17 direction B — client trigger for syncing native Tangerine ERP
// supply (on-hand from inventory_layers, open POs from purchase_orders) into
// the planning supply input tables tagged source='tangerine'. A run whose
// supply_source='tangerine' then reconciles against this data.

import { currentUserEmail } from "../../governance/services/permissionService";

export interface TangerineSupplyResult {
  ok: boolean;
  message: string;
  on_hand?: { snapshot_date: string; layers_scanned: number; snapshot_rows_upserted: number; skus: number; total_units: number };
  open_pos?: { open_pos_scanned: number; open_po_rows_inserted: number };
}

export async function syncTangerineSupply(which: "all" | "on_hand" | "open_pos" = "all"): Promise<TangerineSupplyResult> {
  const res = await fetch("/api/internal/planning/sync-tangerine-supply", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-user-email": currentUserEmail() },
    body: JSON.stringify({ which }),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<TangerineSupplyResult> & { error?: string };
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return { ok: !!json.ok, message: json.message || "", on_hand: json.on_hand, open_pos: json.open_pos };
}
