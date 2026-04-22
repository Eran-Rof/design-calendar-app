// api/_lib/workspaces.js
//
// Shared workspace helpers used by both internal and vendor handlers.
//   • authz helpers (vendor can only touch their own workspaces)
//   • pin resolver (returns a display label for {entity_type, entity_id})
//   • task transition validation

export const PIN_ENTITY_TYPES = ["po", "invoice", "contract", "rfq", "document"];
export const TASK_STATUSES    = ["open", "in_progress", "complete", "cancelled"];
export const ASSIGNEE_TYPES   = ["vendor", "internal"];

export async function loadWorkspace(admin, id) {
  const { data } = await admin
    .from("collaboration_workspaces")
    .select("*, vendor:vendors(id, name)")
    .eq("id", id).maybeSingle();
  return data;
}

export async function vendorIdForAuth(admin, authId) {
  if (!authId) return null;
  const { data } = await admin
    .from("vendor_users").select("vendor_id")
    .eq("auth_id", authId).maybeSingle();
  return data?.vendor_id || null;
}

// Verify that the caller (vendor) is allowed to access this workspace.
// Returns the loaded workspace on success, null on denial.
export async function authorizeVendorAccess(admin, workspaceId, vendorId) {
  if (!workspaceId || !vendorId) return null;
  const w = await loadWorkspace(admin, workspaceId);
  if (!w) return null;
  if (w.vendor_id !== vendorId) return null;
  return w;
}

// Resolve a pinned entity to a lightweight display payload so the UI
// can render chips without doing N follow-up joins.
export async function resolvePin(admin, entity_type, entity_id) {
  if (!entity_id) return null;
  try {
    if (entity_type === "po") {
      const { data } = await admin.from("tanda_pos")
        .select("uuid_id, po_number, vendor_id, status")
        .eq("uuid_id", entity_id).maybeSingle();
      return data ? { id: data.uuid_id, label: `PO ${data.po_number}`, status: data.status } : null;
    }
    if (entity_type === "invoice") {
      const { data } = await admin.from("invoices")
        .select("id, invoice_number, total, status")
        .eq("id", entity_id).maybeSingle();
      return data ? { id: data.id, label: `Invoice ${data.invoice_number}`, status: data.status, total: data.total } : null;
    }
    if (entity_type === "contract") {
      const { data } = await admin.from("contracts")
        .select("id, title, status, end_date")
        .eq("id", entity_id).maybeSingle();
      return data ? { id: data.id, label: data.title, status: data.status, end_date: data.end_date } : null;
    }
    if (entity_type === "rfq") {
      const { data } = await admin.from("rfqs")
        .select("id, title, status")
        .eq("id", entity_id).maybeSingle();
      return data ? { id: data.id, label: `RFQ: ${data.title}`, status: data.status } : null;
    }
    if (entity_type === "document") {
      const { data } = await admin.from("compliance_documents")
        .select("id, document_type_id, status, expiry_date")
        .eq("id", entity_id).maybeSingle();
      return data ? { id: data.id, label: "Compliance doc", status: data.status, expiry_date: data.expiry_date } : null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function resolvePinsBatch(admin, pins) {
  const resolved = [];
  for (const p of pins || []) {
    const payload = await resolvePin(admin, p.entity_type, p.entity_ref_id);
    resolved.push({ ...p, resolved: payload });
  }
  return resolved;
}

export function validateTaskInput(body, { partial = false } = {}) {
  const errs = [];
  if (!partial) {
    if (!body?.title || !String(body.title).trim()) errs.push("title is required");
  }
  if (body?.status !== undefined && !TASK_STATUSES.includes(body.status)) {
    errs.push(`status must be one of ${TASK_STATUSES.join(", ")}`);
  }
  if (body?.assigned_to_type !== undefined && body.assigned_to_type !== null && !ASSIGNEE_TYPES.includes(body.assigned_to_type)) {
    errs.push(`assigned_to_type must be one of ${ASSIGNEE_TYPES.join(", ")}`);
  }
  if (body?.due_date !== undefined && body.due_date !== null && isNaN(Date.parse(String(body.due_date)))) {
    errs.push("due_date must be a valid date string");
  }
  return errs;
}

export function validatePinInput(body) {
  const errs = [];
  if (!PIN_ENTITY_TYPES.includes(body?.entity_type)) {
    errs.push(`entity_type must be one of ${PIN_ENTITY_TYPES.join(", ")}`);
  }
  if (!body?.entity_id) errs.push("entity_id is required");
  return errs;
}
