// api/internal/vendor-access
//
// Internal admin surface to VIEW and CANCEL vendor-portal access.
//
//   GET                                  list every vendor_users row (active +
//                                        disabled + removed), joined to vendors
//   POST { vendor_user_id, action }      action ∈ disable | enable | remove
//
// Why one handler for both verbs: matches the existing internal/* pattern
// (api/_handlers/internal/*/index.js dispatch on method) and keeps routes.js
// from exploding. Internal staff only — gated by authenticateInternalCaller.
//
// ─── What each action does (DB + auth) ──────────────────────────────────────
//
//   disable (reversible):
//     • vendor_users.status = 'disabled'
//     • admin.auth.admin.updateUserById(auth_id, { ban_duration: '876000h' })
//       — bans the GoTrue user (~100 yrs). Blocks new logins AND token refresh,
//       so the vendor's existing browser JWT stops working against PostgREST
//       once it expires (and it can never be refreshed). The server login gate
//       (resolveVendorUser) rejects status!=='active' immediately.
//
//   enable (undo disable):
//     • vendor_users.status = 'active'
//     • admin.auth.admin.updateUserById(auth_id, { ban_duration: 'none' })  — unban.
//
//   remove (hard, irreversible):
//     • admin.auth.admin.deleteUser(auth_id) — deletes the auth.users row.
//       vendor_users.auth_id is ON DELETE CASCADE, so the vendor_users link is
//       removed automatically. Financial/historical tables that reference
//       vendor_users (invoices.submitted_by, shipments, compliance_docs,
//       contracts, disputes, catalog/bulk changes, vendor_notes) are all
//       ON DELETE SET NULL — their rows are PRESERVED, only the author link is
//       nulled. Operational link tables (po_acknowledgments, mobile_sessions,
//       push_notifications) are ON DELETE CASCADE and get cleaned up. No FK is
//       RESTRICT, so nothing blocks the delete and no financial row is orphaned
//       or cascade-deleted.
//       If the auth user cannot be deleted (e.g. already gone, or GoTrue
//       error), we fall back to status='removed' + ban so login is still dead,
//       and report that a hard delete was not possible.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 15 };

// ~100 years — GoTrue's ban_duration is a Go duration string.
const BAN_FOREVER = "876000h";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Supabase not configured" });

  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (req.method === "GET") return doList(req, res, admin);
  if (req.method === "POST") return doMutate(req, res, admin);
  return res.status(405).json({ error: "Method not allowed" });
}

async function doList(req, res, admin) {
  const { data, error } = await admin
    .from("vendor_users")
    .select("id, auth_id, vendor_id, display_name, role, last_login, status, vendor:vendors(id, name, email)")
    .order("last_login", { ascending: false, nullsFirst: false });
  if (error) return res.status(500).json({ error: error.message });

  const out = (data || []).map((r) => ({
    id: r.id,
    auth_id: r.auth_id,
    vendor_id: r.vendor_id,
    vendor_name: r.vendor?.name || null,
    email: r.vendor?.email || null,
    display_name: r.display_name || null,
    role: r.role || null,
    last_login: r.last_login || null,
    status: r.status || "active",
  }));

  // active first, then disabled, then removed; within a group newest-login first.
  const rank = { active: 0, disabled: 1, removed: 2 };
  out.sort(
    (a, b) =>
      (rank[a.status] ?? 9) - (rank[b.status] ?? 9) ||
      (new Date(b.last_login || 0) - new Date(a.last_login || 0))
  );

  return res.status(200).json(out);
}

async function doMutate(req, res, admin) {
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const vendorUserId = String(body?.vendor_user_id || "").trim();
  const action = String(body?.action || "").trim().toLowerCase();
  if (!vendorUserId) return res.status(400).json({ error: "vendor_user_id is required" });
  if (!["disable", "enable", "remove"].includes(action)) {
    return res.status(400).json({ error: "action must be one of: disable, enable, remove" });
  }

  // Resolve auth_id server-side — never trust a client-supplied auth_id.
  const { data: row, error: rErr } = await admin
    .from("vendor_users")
    .select("id, auth_id, status")
    .eq("id", vendorUserId)
    .maybeSingle();
  if (rErr) return res.status(500).json({ error: "Lookup failed: " + rErr.message });
  if (!row) return res.status(404).json({ error: "Vendor user not found" });

  if (action === "disable") {
    const { error: uErr } = await admin
      .from("vendor_users")
      .update({ status: "disabled" })
      .eq("id", vendorUserId);
    if (uErr) return res.status(500).json({ error: "Could not disable: " + uErr.message });
    if (row.auth_id) {
      const { error: bErr } = await admin.auth.admin.updateUserById(row.auth_id, { ban_duration: BAN_FOREVER });
      if (bErr) {
        // status is already disabled (server gate blocks API). Report the
        // session-revocation failure so the operator knows the live JWT may
        // survive until it expires.
        return res.status(200).json({
          ok: true, status: "disabled",
          warning: "Status set to disabled, but revoking the live session failed: " + bErr.message,
        });
      }
    }
    return res.status(200).json({ ok: true, status: "disabled" });
  }

  if (action === "enable") {
    const { error: uErr } = await admin
      .from("vendor_users")
      .update({ status: "active" })
      .eq("id", vendorUserId);
    if (uErr) return res.status(500).json({ error: "Could not enable: " + uErr.message });
    if (row.auth_id) {
      const { error: bErr } = await admin.auth.admin.updateUserById(row.auth_id, { ban_duration: "none" });
      if (bErr) {
        return res.status(200).json({
          ok: true, status: "active",
          warning: "Status set to active, but lifting the login ban failed: " + bErr.message,
        });
      }
    }
    return res.status(200).json({ ok: true, status: "active" });
  }

  // action === "remove" — hard, irreversible.
  // Preferred: delete the auth user. vendor_users.auth_id is ON DELETE CASCADE,
  // so the link row vanishes; all financial/historical FKs are SET NULL and are
  // preserved. No RESTRICT FK exists to block this.
  if (row.auth_id) {
    const { error: dErr } = await admin.auth.admin.deleteUser(row.auth_id);
    if (!dErr) {
      // CASCADE removed vendor_users. Confirm it's gone; if for any reason the
      // link survived (shouldn't happen), mark it removed + leave the ban.
      const { data: still } = await admin
        .from("vendor_users")
        .select("id")
        .eq("id", vendorUserId)
        .maybeSingle();
      if (still) {
        await admin.from("vendor_users").update({ status: "removed" }).eq("id", vendorUserId);
      }
      return res.status(200).json({ ok: true, status: "removed", hard_deleted: true });
    }
    // Auth delete failed — fall back to soft removal so login is still dead.
    await admin.auth.admin.updateUserById(row.auth_id, { ban_duration: BAN_FOREVER }).catch(() => {});
    const { error: sErr } = await admin
      .from("vendor_users")
      .update({ status: "removed" })
      .eq("id", vendorUserId);
    if (sErr) return res.status(500).json({ error: "Remove failed: " + dErr.message + " / " + sErr.message });
    return res.status(200).json({
      ok: true, status: "removed", hard_deleted: false,
      warning: "Hard delete of the login was not possible (" + dErr.message +
        "). Access has been revoked (status=removed + login banned) instead.",
    });
  }

  // No auth_id on record — nothing to delete in GoTrue; just mark removed.
  const { error: sErr } = await admin
    .from("vendor_users")
    .update({ status: "removed" })
    .eq("id", vendorUserId);
  if (sErr) return res.status(500).json({ error: "Remove failed: " + sErr.message });
  return res.status(200).json({ ok: true, status: "removed", hard_deleted: false });
}
