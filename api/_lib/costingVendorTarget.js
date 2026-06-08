// api/_lib/costingVendorTarget.js
//
// The per-unit target a vendor quotes against on an RFQ line:
//   - DDP projects   → the Tgt DDP cost (costing_lines.target_cost)
//   - FOB/Landed     → the FOB cost (costing_lines.fob_cost), falling back to
//                      target_cost when fob_cost isn't populated yet.
//
// Cost mode is derived upstream from costing_projects.payment_terms_name
// (/DDP/i — mirrors src/costing/lib/completeness.ts isDdpProject). Returns a
// positive number or null. Shared by RFQ generation + the costing-line-edit
// propagation so both write the SAME basis (and never the sell price).

export function vendorTargetForMode(isDdp, targetCost, fobCost) {
  const toNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const ddp = toNum(targetCost);
  const fob = toNum(fobCost);
  return isDdp ? ddp : (fob != null ? fob : ddp);
}
