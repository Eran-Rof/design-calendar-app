// api/_lib/accounting/posting/rules/mfgBuildIssue.js
//
// Manufacturing — issue components into a build's WIP (M4).
//
// Consumes each PART (from part inventory) and each consumed FINISHED STYLE
// (from style inventory) into the build's WIP asset account at ACTUAL FIFO cost.
// Service components are NOT issued here — they are vendor charges capitalized
// separately (mfgServiceCapitalized).
//
//   For each component → one sentinel pair:
//     DR 1205 WIP        (subledger=build_order, id=build_order_id)
//     CR inventory       (parts → 1360 subledger=part; style → inv acct subledger=item)
//   plus a partConsumePlan (parts) / consumePlan (styles) entry with explicit
//   dr_line_ix / cr_line_ix. postEvent's indexed drains FIFO-consume each and
//   rewrite the sentinels with the per-component COGS.
//
// LINE ORDERING — parts FIRST, styles LAST. postEvent runs the style consumePlan
// drain before the part partConsumePlan drain; a zero-cogs style pair is dropped
// + the line array renumbered. Putting style pairs at the TAIL means such a drop
// never shifts the part pairs' array positions, so the part drain's indices stay
// valid. (Both are non-cash internal moves → identical JE on accrual + cash.)

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     build_order_id, posting_date, wip_account_id, build_number?,
 *     components: Array<{
 *       component_kind: 'part'|'finished_style',
 *       part_id?|item_id?,          // part_id for parts; item_id for styles
 *       qty: number|string,         // qty_required to consume
 *       inventory_account_id,       // CR account (1360 parts / style inv acct)
 *       location_id?,
 *     }>,
 *   }
 */
export function mfgBuildIssue(event) {
  const d = event.data;
  required(d, ["build_order_id", "posting_date", "wip_account_id", "components"]);
  if (!Array.isArray(d.components) || d.components.length === 0) {
    throw new Error("mfgBuildIssue: components must be a non-empty array");
  }

  const desc = `Build issue ${d.build_number || d.build_order_id}`;
  const lines = [];
  const partConsumePlan = [];
  const consumePlan = [];

  const parts = d.components.filter((c) => c.component_kind === "part");
  const styles = d.components.filter((c) => c.component_kind === "finished_style");
  if (parts.length + styles.length !== d.components.length) {
    throw new Error("mfgBuildIssue: components must be part or finished_style only (services are capitalized separately)");
  }

  // Parts first.
  for (const c of parts) {
    if (!c.part_id) throw new Error("mfgBuildIssue: part component missing part_id");
    if (!c.inventory_account_id) throw new Error("mfgBuildIssue: part component missing inventory_account_id");
    const drIx = lines.length;
    lines.push(wipLine(d, desc));
    const crIx = lines.length;
    lines.push({ line_number: 0, account_id: c.inventory_account_id, debit: "0", credit: "0", memo: desc, subledger_type: "part", subledger_id: c.part_id });
    partConsumePlan.push({ part_id: c.part_id, qty: c.qty, consumer_kind: "build_issue", consumer_ref_id: d.build_order_id, location_id: c.location_id || null, dr_line_ix: drIx, cr_line_ix: crIx });
  }
  // Styles last.
  for (const c of styles) {
    if (!c.item_id) throw new Error("mfgBuildIssue: finished_style component missing item_id");
    if (!c.inventory_account_id) throw new Error("mfgBuildIssue: finished_style component missing inventory_account_id");
    const drIx = lines.length;
    lines.push(wipLine(d, desc));
    const crIx = lines.length;
    lines.push({ line_number: 0, account_id: c.inventory_account_id, debit: "0", credit: "0", memo: desc, subledger_type: "item", subledger_id: c.item_id });
    consumePlan.push({ item_id: c.item_id, qty: c.qty, consumer_kind: "transfer_out", consumer_ref_id: d.build_order_id, dr_line_ix: drIx, cr_line_ix: crIx });
  }

  lines.forEach((l, i) => { l.line_number = i + 1; });

  const base = {
    entity_id: event.entity_id,
    journal_type: "manufacture_issue",
    posting_date: d.posting_date,
    source_module: "inventory",
    source_table: "mfg_build_issue",
    source_id: d.build_order_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    lines,
  };
  const out = {
    accrual: { ...base, basis: "ACCRUAL", lines: cloneLines(lines) },
    cash:    { ...base, basis: "CASH",    lines: cloneLines(lines) },
  };
  if (partConsumePlan.length > 0) out.partConsumePlan = partConsumePlan;
  if (consumePlan.length > 0) out.consumePlan = consumePlan;
  return out;
}

function wipLine(d, desc) {
  return { line_number: 0, account_id: d.wip_account_id, debit: "0", credit: "0", memo: desc, subledger_type: "build_order", subledger_id: d.build_order_id };
}
function required(obj, fields) {
  for (const f of fields) {
    if (obj?.[f] == null || obj[f] === "") throw new Error(`mfgBuildIssue: data.${f} is required`);
  }
}
function cloneLines(lines) { return lines.map((l) => ({ ...l })); }
