// api/vendor/rfqs/:id
//
// GET — RFQ detail for an invited vendor. Returns RFQ header, line
// items, the vendor's invitation row, and the vendor's own draft/
// submitted quote (never any other vendor's quote).
//
// Side effect: on the first view, the invitation's viewed_at is set
// and status flips 'invited' → 'viewed'.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("id, vendor_id").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id } : null;
  } catch { return null; }
}

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("rfqs");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing rfq id" });

  // Enforce: vendor must have an invitation to see this RFQ
  const { data: invitation } = await admin
    .from("rfq_invitations")
    .select("*")
    .eq("rfq_id", id)
    .eq("vendor_id", caller.vendor_id)
    .maybeSingle();
  if (!invitation) return res.status(404).json({ error: "RFQ not found or you're not invited" });

  const [rfqRes, liRes, qtRes] = await Promise.all([
    admin.from("rfqs").select("*").eq("id", id).maybeSingle(),
    admin.from("rfq_line_items").select("*").eq("rfq_id", id).order("line_index", { ascending: true }),
    admin.from("rfq_quotes").select("*, lines:rfq_quote_lines(*)").eq("rfq_id", id).eq("vendor_id", caller.vendor_id).maybeSingle(),
  ]);

  // Mark viewed on first visit
  if (!invitation.viewed_at) {
    await admin.from("rfq_invitations").update({
      viewed_at: new Date().toISOString(),
      status: invitation.status === "invited" ? "viewed" : invitation.status,
    }).eq("id", invitation.id);
  }

  // Resolve fabric NAME from fabric_codes (the line carries only the code,
  // e.g. "DEN12" → "12oz Denim") so the vendor view can show the friendly name.
  const lineItems = liRes.data || [];
  const fabricCodes = Array.from(new Set(lineItems.map((li) => li.fabric_code).filter(Boolean)));
  let nameByCode = new Map();
  if (fabricCodes.length > 0) {
    const { data: fcs } = await admin.from("fabric_codes").select("code, name").in("code", fabricCodes);
    nameByCode = new Map((fcs || []).map((f) => [f.code, f.name]));
  }
  for (const li of lineItems) {
    li.fabric_name = li.fabric_code ? (nameByCode.get(li.fabric_code) || null) : null;
  }

  // Documents attached to the RFQ's source costing lines (tech packs, spec
  // sheets, reference images) so the vendor actually receives what the buyer
  // attached when costing the style. The costing-line attach UI writes these to
  // the generic `documents` table keyed (context_table='costing_lines',
  // context_id=<costing_line_id>); rfq_line_items.costing_line_id back-points to
  // that line. Images are surfaced as a product-image strip; everything else as
  // downloadable files. Signed URLs are minted here (1h TTL) so <img>/download
  // links work without a second authenticated round-trip.
  const documents = await resolveLineDocuments(admin, lineItems);

  // The vendor's OWN quote revision history (read-only). rfq_quote_revisions is
  // service-role only; we scope strictly to this vendor's quote so a vendor can
  // only ever see THEIR prior versions — never another vendor's, never ROF
  // internals. Snapshots hold the prior header + per-line figures.
  let quoteRevisions = [];
  if (qtRes.data?.id) {
    const { data: revs } = await admin
      .from("rfq_quote_revisions")
      .select("id, revision, snapshot, submitted_at, created_at")
      .eq("quote_id", qtRes.data.id)
      .eq("vendor_id", caller.vendor_id)
      .order("revision", { ascending: false });
    quoteRevisions = revs || [];
  }

  return res.status(200).json({
    rfq: rfqRes.data,
    line_items: lineItems,
    invitation,
    quote: qtRes.data ? { ...qtRes.data, revisions: quoteRevisions } : null,
    documents,
  });
}

const DOCUMENTS_BUCKET = "tangerine-documents";

async function resolveLineDocuments(admin, lineItems) {
  const costingLineIds = Array.from(
    new Set(lineItems.map((li) => li.costing_line_id).filter(Boolean)),
  );
  if (costingLineIds.length === 0) return [];

  const lineIndexByCostingId = new Map(
    lineItems.filter((li) => li.costing_line_id).map((li) => [li.costing_line_id, li.line_index]),
  );

  // Active documents on those costing lines, with the current version's
  // storage path + mime. Tolerate the join failing (returns [] → no docs).
  const { data: docs, error } = await admin
    .from("documents")
    .select("id, title, kind, context_id, current_version:document_versions!documents_current_version_fk(storage_path, mime_type, byte_size)")
    .eq("context_table", "costing_lines")
    .in("context_id", costingLineIds)
    .eq("is_archived", false)
    .order("created_at", { ascending: true });
  if (error || !docs || docs.length === 0) return [];

  const withPaths = docs.filter((d) => d.current_version?.storage_path);
  if (withPaths.length === 0) return [];

  // Batch-sign every path in one call (1h TTL — covers a quoting session).
  let signedByPath = new Map();
  try {
    const { data: signed } = await admin.storage
      .from(DOCUMENTS_BUCKET)
      .createSignedUrls(withPaths.map((d) => d.current_version.storage_path), 3600);
    signedByPath = new Map((signed || []).map((s) => [s.path, s.signedUrl || s.signedURL || null]));
  } catch {
    return [];
  }

  return withPaths
    .map((d) => {
      const mime = d.current_version.mime_type || "";
      const url = signedByPath.get(d.current_version.storage_path) || null;
      if (!url) return null;
      return {
        id: d.id,
        title: d.title,
        kind: d.kind,
        mime,
        is_image: mime.startsWith("image/"),
        byte_size: d.current_version.byte_size || null,
        line_index: lineIndexByCostingId.get(d.context_id) || null,
        url,
      };
    })
    .filter(Boolean);
}
