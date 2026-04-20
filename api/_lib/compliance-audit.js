// api/_lib/compliance-audit.js
//
// Helpers for writing and summarizing compliance_audit_trail rows.
//
//   writeAudit(admin, { vendor_id, document_id?, action, performed_by_type,
//                       performed_by?, notes? })
//     → inserts one row; swallows errors so callers stay non-blocking
//
//   automationSummary(admin, { from_iso, to_iso })
//     → { requests_sent, renewals_completed, escalations_open,
//         by_document_type: { [type_id]: { requests, renewals, escalations } } }

export const AUDIT_ACTIONS = [
  "uploaded", "reviewed", "approved", "rejected", "expired", "renewed", "requested",
];

export async function writeAudit(admin, {
  vendor_id, document_id = null, action,
  performed_by_type, performed_by = null, notes = null,
}) {
  if (!vendor_id || !action || !performed_by_type) return { ok: false, error: "missing fields" };
  if (!AUDIT_ACTIONS.includes(action)) return { ok: false, error: `unknown action: ${action}` };
  try {
    const { error } = await admin.from("compliance_audit_trail").insert({
      vendor_id, document_id, action, performed_by_type, performed_by, notes,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function automationSummary(admin, { from_iso, to_iso }) {
  const { data: rows } = await admin
    .from("compliance_audit_trail")
    .select("action, document_id, created_at")
    .gte("created_at", from_iso)
    .lte("created_at", to_iso);

  // Fetch documents to join to document_type for the breakdown
  const docIds = [...new Set((rows || []).filter((r) => r.document_id).map((r) => r.document_id))];
  const docMap = {};
  if (docIds.length) {
    const { data: docs } = await admin.from("compliance_documents").select("id, document_type_id").in("id", docIds);
    for (const d of docs || []) docMap[d.id] = d.document_type_id;
  }

  const summary = {
    requests_sent: 0,
    renewals_completed: 0,
    escalations_open: 0,
    by_document_type: {},
  };
  for (const r of rows || []) {
    const typeId = r.document_id ? docMap[r.document_id] : null;
    const bucket = typeId ? (summary.by_document_type[typeId] ||= { requests: 0, renewals: 0, escalations: 0 }) : null;
    if (r.action === "requested") {
      summary.requests_sent += 1; if (bucket) bucket.requests += 1;
    } else if (r.action === "renewed" || r.action === "approved") {
      summary.renewals_completed += 1; if (bucket) bucket.renewals += 1;
    }
  }

  // Escalations_open = documents that were requested but have no renewed/approved since.
  // Collect latest action per document_id.
  const latestByDoc = {};
  for (const r of (rows || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at))) {
    if (!r.document_id) continue;
    latestByDoc[r.document_id] = r.action;
  }
  for (const docId of Object.keys(latestByDoc)) {
    if (latestByDoc[docId] === "requested") {
      summary.escalations_open += 1;
      const typeId = docMap[docId];
      if (typeId) {
        const b = (summary.by_document_type[typeId] ||= { requests: 0, renewals: 0, escalations: 0 });
        b.escalations += 1;
      }
    }
  }

  return summary;
}
