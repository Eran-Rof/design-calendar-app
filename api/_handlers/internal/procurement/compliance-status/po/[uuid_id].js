// api/internal/procurement/compliance-status/po/[uuid_id]
//
// Tangerine P13-6 — M48 per-PO compliance status synthesizer.
//
// GET — given a tanda_pos.uuid_id (= tanda_pos.id in the current Tangerine
//       schema; the path-param name follows the memory rule that
//       procurement code references tanda_pos via the uuid form), return:
//         {
//           tanda_po_id, po_number, vendor_id, vendor_name,
//           required_certs: ["OEKO-TEX", "GOTS"],
//           required_docs:  ["commercial_invoice", "packing_list", "bill_of_lading", "customs_declaration"],
//           vendor_certs_active: [...cert rows whose status='active' and
//                                 either expires_at IS NULL or > today],
//           import_docs: [...docs for this PO],
//           missing_certs: [...required certs the vendor is missing],
//           missing_docs:  [...required doc_types not present for this PO],
//           is_complete: boolean       // true iff missing_certs.length=0 AND missing_docs.length=0
//         }
//
// The exported assembleStatus() helper is pure so it can be unit-tested
// without a live database.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "At-least-one-of" for vendor certs: vendor passes the cert check if they
// have an active OEKO-TEX OR an active GOTS row. This matches the task spec
// "active OEKO-TEX/GOTS".
export const REQUIRED_CERT_TYPES = ["OEKO-TEX", "GOTS"];

export const REQUIRED_DOC_TYPES = [
  "commercial_invoice",
  "packing_list",
  "bill_of_lading",
  "customs_declaration",
];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const uuidId = req.query?.uuid_id;
  if (!uuidId || !UUID_RE.test(uuidId)) {
    return res.status(400).json({ error: "Invalid uuid_id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Resolve PO — try both id (uuid PK per T5 backfill) and uuid_id
  // (legacy synonym; some pre-T5 rows still have it set to the same value).
  const { data: po, error: poErr } = await admin
    .from("tanda_pos")
    .select("id, po_number, vendor_id, uuid_id")
    .or(`id.eq.${uuidId},uuid_id.eq.${uuidId}`)
    .limit(1)
    .maybeSingle();
  if (poErr) return res.status(500).json({ error: poErr.message });
  if (!po) return res.status(404).json({ error: "PO not found" });

  const poId = po.id;

  // Vendor cert rows (active only).
  let vendorCerts = [];
  if (po.vendor_id) {
    const { data: certs } = await admin
      .from("vendor_compliance_certifications")
      .select("*")
      .eq("vendor_id", po.vendor_id)
      .eq("status", "active");
    vendorCerts = certs || [];
  }

  // Resolve vendor name for the response.
  let vendorName = null;
  if (po.vendor_id) {
    const { data: vendor } = await admin
      .from("vendors")
      .select("id, name")
      .eq("id", po.vendor_id)
      .maybeSingle();
    vendorName = vendor?.name || null;
  }

  // Import docs for this PO.
  const { data: docs, error: docErr } = await admin
    .from("import_documentation")
    .select("*")
    .eq("tanda_po_id", poId);
  if (docErr) return res.status(500).json({ error: docErr.message });

  const todayStr = new Date().toISOString().slice(0, 10);
  const status = assembleStatus({
    po: { tanda_po_id: poId, po_number: po.po_number, vendor_id: po.vendor_id, vendor_name: vendorName },
    vendorCerts,
    importDocs: docs || [],
    today: todayStr,
  });

  return res.status(200).json(status);
}

// ────────────────────────────────────────────────────────────────────────
// Pure helper — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

/**
 * Given a PO context + vendor cert rows + import docs, produce the
 * compliance status object. Pure — no DB calls.
 *
 * @param {Object} args
 * @param {{tanda_po_id:string, po_number:string|null, vendor_id:string|null, vendor_name:string|null}} args.po
 * @param {Array} args.vendorCerts
 * @param {Array} args.importDocs
 * @param {string} args.today  YYYY-MM-DD (compares against expires_at)
 * @returns {Object}
 */
export function assembleStatus({ po, vendorCerts, importDocs, today }) {
  // Active = status='active' AND (no expiry OR expiry in the future).
  const activeCerts = (vendorCerts || []).filter((c) => {
    if (c.status !== "active") return false;
    if (!c.expires_at) return true;
    return c.expires_at >= today;
  });

  // "Pass the cert check" if AT LEAST ONE of the required cert types is
  // present. (Tightening this to ALL would lock out non-textile suppliers
  // for whom only OEKO-TEX or only GOTS makes sense.)
  const activeTypes = new Set(activeCerts.map((c) => c.certification_type));
  const missingCerts = REQUIRED_CERT_TYPES.every((t) => !activeTypes.has(t))
    ? [...REQUIRED_CERT_TYPES]
    : [];

  const presentDocTypes = new Set(
    (importDocs || [])
      .filter((d) => d.status !== "pending")
      .map((d) => d.document_type),
  );
  const missingDocs = REQUIRED_DOC_TYPES.filter((t) => !presentDocTypes.has(t));

  return {
    tanda_po_id: po.tanda_po_id,
    po_number: po.po_number,
    vendor_id: po.vendor_id,
    vendor_name: po.vendor_name,
    required_certs: [...REQUIRED_CERT_TYPES],
    required_docs:  [...REQUIRED_DOC_TYPES],
    vendor_certs_active: activeCerts,
    import_docs: importDocs || [],
    missing_certs: missingCerts,
    missing_docs:  missingDocs,
    is_complete: missingCerts.length === 0 && missingDocs.length === 0,
  };
}

export function isUuid(s) {
  return typeof s === "string" && UUID_RE.test(s);
}
