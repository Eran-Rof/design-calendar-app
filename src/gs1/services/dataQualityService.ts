// ── GS1 Data Quality — pure check functions ────────────────────────────────────
// All functions are side-effect-free; they take in-memory data and return issues.

import type {
  PackGtin,
  UpcItem,
  ScaleMaster,
  LabelBatchLine,
  Carton,
  ReceivingSession,
  DataQualityIssueInput,
  DQSeverity,
  ExceptionGroup,
  DataQualityIssue,
} from "../types";

export interface DQCheckInput {
  packGtins: PackGtin[];
  upcItems: UpcItem[];
  scales: ScaleMaster[];
  batchLines: LabelBatchLine[];
  cartons: Carton[];
  receivingSessions: ReceivingSession[];
}

export function runDataQualityChecks(data: DQCheckInput): DataQualityIssueInput[] {
  const issues: DataQualityIssueInput[] = [];

  // Pack GTIN without any BOM attempt
  for (const g of data.packGtins) {
    if (g.bom_status === "not_built") {
      issues.push({
        issue_type: "gtin_no_bom",
        severity:   "warning",
        entity_type: "pack_gtin",
        entity_id:  g.pack_gtin,
        message:    `Pack GTIN ${g.pack_gtin} (${g.style_no}/${g.color}/${g.scale_code}) has no BOM built yet.`,
        context:    { style_no: g.style_no, color: g.color, scale_code: g.scale_code },
      });
    }

    // Incomplete BOM — missing UPC references
    if (g.bom_status === "incomplete") {
      issues.push({
        issue_type: "gtin_incomplete_bom",
        severity:   "error",
        entity_type: "pack_gtin",
        entity_id:  g.pack_gtin,
        message:    `Pack GTIN ${g.pack_gtin} (${g.style_no}/${g.color}/${g.scale_code}) BOM is incomplete — missing UPC(s).`,
        context:    { style_no: g.style_no, color: g.color, scale_code: g.scale_code, bom_issue_summary: g.bom_issue_summary },
      });
    }

    // GTIN digit-length check
    if (g.pack_gtin.length !== 14) {
      issues.push({
        issue_type: "invalid_gtin_length",
        severity:   "error",
        entity_type: "pack_gtin",
        entity_id:  g.pack_gtin,
        message:    `Pack GTIN "${g.pack_gtin}" is ${g.pack_gtin.length} digits (expected 14).`,
        context:    { style_no: g.style_no, color: g.color },
      });
    }
  }

  // Scale with zero / null total units
  for (const s of data.scales) {
    if (!s.total_units || s.total_units === 0) {
      issues.push({
        issue_type: "scale_zero_units",
        severity:   "warning",
        entity_type: "scale",
        entity_id:  s.scale_code,
        message:    `Scale "${s.scale_code}" has ${s.total_units ?? "null"} total units — no ratios defined?`,
        context:    { scale_code: s.scale_code, total_units: s.total_units },
      });
    }
  }

  // UPC duplicate conflicts: same style/color/size mapped to more than one UPC
  const upcKeyMap = new Map<string, string[]>();
  for (const u of data.upcItems) {
    const key = `${u.style_no}|${u.color}|${u.size}`;
    const arr = upcKeyMap.get(key);
    if (arr) arr.push(u.upc);
    else upcKeyMap.set(key, [u.upc]);
  }
  for (const [key, upcs] of upcKeyMap) {
    if (upcs.length > 1) {
      const [style_no, color, size] = key.split("|");
      issues.push({
        issue_type: "upc_duplicate",
        severity:   "error",
        entity_type: "upc_item",
        entity_id:  key,
        message:    `Duplicate UPCs for ${style_no}/${color}/${size}: ${upcs.join(", ")}`,
        context:    { style_no, color, size, upcs },
      });
    }
  }

  // SSCC length check
  for (const c of data.cartons) {
    if (c.sscc.length !== 18) {
      issues.push({
        issue_type: "invalid_sscc_length",
        severity:   "error",
        entity_type: "carton",
        entity_id:  c.id,
        message:    `Carton SSCC "${c.sscc}" is ${c.sscc.length} digits (expected 18).`,
        context:    { sscc: c.sscc, status: c.status },
      });
    }

    // Carton generated but no pack_gtin
    if (!c.pack_gtin && c.status === "generated") {
      issues.push({
        issue_type: "carton_no_gtin",
        severity:   "warning",
        entity_type: "carton",
        entity_id:  c.id,
        message:    `Carton ${c.sscc} has no pack_gtin assigned.`,
        context:    { sscc: c.sscc },
      });
    }
  }

  // Label batch lines with label_qty ≤ 0
  for (const line of data.batchLines) {
    if (line.label_qty <= 0) {
      issues.push({
        issue_type: "batch_line_zero_qty",
        severity:   "warning",
        entity_type: "label_batch_line",
        entity_id:  line.id,
        message:    `Batch line for ${line.style_no}/${line.color}/${line.scale_code} has label_qty of ${line.label_qty}.`,
        context:    { batch_id: line.batch_id, pack_gtin: line.pack_gtin },
      });
    }
  }

  // Receiving sessions with variance
  for (const s of data.receivingSessions) {
    if (s.status === "variance") {
      issues.push({
        issue_type: "receiving_variance",
        severity:   "warning",
        entity_type: "receiving_session",
        entity_id:  s.id,
        message:    `Receiving session for SSCC ${s.sscc} has unresolved variance.`,
        context:    { sscc: s.sscc, received_at: s.received_at },
      });
    }
  }

  return issues;
}

// ── Exception grouping for dashboard ─────────────────────────────────────────

const EXCEPTION_META: Record<string, { label: string; description: string; severity: DQSeverity; tab?: string }> = {
  gtin_no_bom:        { label: "Missing BOMs",          description: "Pack GTINs with no BOM built",              severity: "warning", tab: "gtins" },
  gtin_incomplete_bom: { label: "Incomplete BOMs",       description: "Pack GTINs with missing UPC references",    severity: "error",   tab: "gtins" },
  invalid_gtin_length: { label: "Invalid GTIN lengths",  description: "Pack GTINs that are not exactly 14 digits", severity: "error",   tab: "gtins" },
  scale_zero_units:    { label: "Empty Scales",          description: "Scale codes with no size ratios defined",   severity: "warning", tab: "scale" },
  upc_duplicate:       { label: "Duplicate UPCs",        description: "Same style/color/size with multiple UPCs",  severity: "error",   tab: "upc"   },
  invalid_sscc_length: { label: "Invalid SSCC lengths",  description: "Carton SSCCs that are not exactly 18 digits",severity: "error",  tab: "cartons"},
  carton_no_gtin:      { label: "Cartons Without GTIN",  description: "Generated cartons missing a pack GTIN",     severity: "warning", tab: "cartons"},
  batch_line_zero_qty: { label: "Zero-Qty Batch Lines",  description: "Batch lines with label_qty ≤ 0",            severity: "warning", tab: "labels" },
  receiving_variance:  { label: "Receiving Variances",   description: "Receiving sessions with qty mismatches",    severity: "warning", tab: "receiving"},
};

export function buildExceptionGroups(issues: DataQualityIssue[]): ExceptionGroup[] {
  const openIssues = issues.filter(i => i.status === "open");
  const byType = new Map<string, DataQualityIssue[]>();
  for (const issue of openIssues) {
    const arr = byType.get(issue.issue_type);
    if (arr) arr.push(issue);
    else byType.set(issue.issue_type, [issue]);
  }

  const groups: ExceptionGroup[] = [];
  for (const [key, arr] of byType) {
    const meta = EXCEPTION_META[key] ?? {
      label:       key.replace(/_/g, " "),
      description: key,
      severity:    "info" as DQSeverity,
    };
    const newest_at = arr.reduce<string | null>((max, i) =>
      !max || i.created_at > max ? i.created_at : max, null
    );
    groups.push({ key, label: meta.label, description: meta.description, count: arr.length, severity: meta.severity, newest_at, tab: meta.tab });
  }

  // Sort: errors first, then warnings, then info; then by count desc
  const order: Record<DQSeverity, number> = { error: 0, warning: 1, info: 2 };
  groups.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
  return groups;
}

// Returns only open issues for a specific issue_type
export function filterOpenByType(issues: DataQualityIssue[], issueType: string): DataQualityIssue[] {
  return issues.filter(i => i.status === "open" && i.issue_type === issueType);
}

// Quick count of open issues, grouped by type
export function countOpenByType(issues: DataQualityIssue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const i of issues) {
    if (i.status !== "open") continue;
    counts[i.issue_type] = (counts[i.issue_type] ?? 0) + 1;
  }
  return counts;
}
