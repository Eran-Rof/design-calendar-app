// Pure helpers for the execution Detail view — kept dependency-free so they can
// be unit-tested without pulling in the panel's heavy (exceljs) export chain.

import type { IpExecutionBatch } from "../types/execution";
import type { TangerinePoResult } from "../services/tangerinePoService";

// Deep-link target for the Tangerine native PO panel (Procurement → Purchase
// Orders). Planning runs at /planning, so created POs open in a new tab.
export const PO_PANEL_URL = "/tangerine?m=purchase_orders";

// The planning-vendor management screen (WP3). Vendor skips link here.
export const VENDORS_URL = "/planning/vendors";

// Style key = sku_code up to (not including) the last "-" color suffix, so
// "ABC123-BLK" and "ABC123-WHT" share style "ABC123". Used to bulk-assign a
// vendor to every unassigned line of the same style.
export function styleOf(skuCode: string): string {
  const i = skuCode.lastIndexOf("-");
  return i > 0 ? skuCode.slice(0, i) : skuCode;
}

export type NextStepActionKind = "moveReady" | "approve" | "preview" | "createPos" | "issue";
export interface NextStepAction { label: string; kind: NextStepActionKind }
export interface NextStep {
  key: string;
  title: string;
  detail?: string;
  tone: "action" | "blocked" | "done" | "muted";
  primary?: NextStepAction;
  secondary?: NextStepAction;
  href?: string;
}
export interface NextStepContext {
  canApproveBatch: boolean;
  // POs already created for this batch (persisted on actions, survives refresh).
  posCreated: boolean;
}

// Pure state → single-next-action mapping. Extracted so it can be unit-tested
// without rendering. The banner in the component is a thin router onto the
// existing handlers keyed by NextStepAction.kind.
export function nextStepFor(
  batch: Pick<IpExecutionBatch, "status">,
  preview: TangerinePoResult | null,
  ctx: NextStepContext,
): NextStep {
  const status = batch.status;

  if (status === "archived") {
    return { key: "archived", title: "This batch is archived — read-only.", tone: "muted" };
  }

  const createdFromPreview = !!preview && !preview.dry_run && preview.created.some((c) => !!c.po_id);
  if (ctx.posCreated || createdFromPreview || status === "executed") {
    return {
      key: "done",
      title: "Done here — issue the draft POs in Procurement",
      detail: "Issuing assigns PO numbers and opens commitments. The drafts stay editable in Procurement until you do.",
      tone: "done",
      href: PO_PANEL_URL,
    };
  }

  if (status === "draft") {
    return { key: "draft", title: "Next: move this batch to ready", tone: "action", primary: { label: "Move to ready", kind: "moveReady" } };
  }

  if (status === "ready") {
    if (!ctx.canApproveBatch) {
      return {
        key: "ready-blocked",
        title: "Next: approve this batch",
        detail: "You lack the approve_execution role — ask an admin / operations user to approve it.",
        tone: "blocked",
      };
    }
    return { key: "ready", title: "Next: approve this batch", tone: "action", primary: { label: "Approve batch", kind: "approve" } };
  }

  // approved / exported / submitted / partially_executed / failed — the PO path.
  if (!preview) {
    return {
      key: "preview",
      title: "Next: preview the draft POs (nothing is written)",
      detail: "See which vendors would get a PO and which lines skip — before anything is created.",
      tone: "action",
      primary: { label: "Preview draft POs", kind: "preview" },
    };
  }

  const skipped = preview.diagnostics?.skipped ?? preview.skipped.length;
  const eligible = preview.diagnostics?.eligible_lines ?? preview.created.reduce((n, c) => n + c.line_count, 0);
  const total = preview.diagnostics?.actions_total ?? eligible + skipped;

  if (skipped > 0) {
    return {
      key: "preview-skips",
      title: `${skipped} of ${total} lines will be skipped — fix them below, or create POs for the ${eligible} eligible line(s)`,
      tone: eligible > 0 ? "action" : "blocked",
      primary: eligible > 0 ? { label: "Create draft POs in Tangerine", kind: "createPos" } : undefined,
      secondary: { label: "Re-preview", kind: "preview" },
    };
  }

  return {
    key: "preview-clean",
    title: "Next: create draft POs in Tangerine — one per vendor",
    detail: "Nothing is issued yet — the POs are created as drafts for you to review.",
    tone: "action",
    primary: { label: "Create draft POs in Tangerine", kind: "createPos" },
    secondary: { label: "Re-preview", kind: "preview" },
  };
}
