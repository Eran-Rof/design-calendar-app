// api/vendor/contracts/:id/sign
//
// POST — vendor uploads countersigned contract.
//   body: { file_url, file_name, file_size_bytes?, file_mime_type? }
//   The client pre-uploads the signed PDF to bucket 'vendor-contracts'
//   at '<vendor_id>/<contract_id>/<filename>', then calls this endpoint.
//
// Effects:
//   - Validates file is PDF, <=20MB
//   - Sets contract.signed_file_url = file_url
//   - Sets status='signed', signed_at=now(), signed_by_vendor=caller
//   - Inserts a new contract_versions row (next version_number, type='vendor')
//   - Fires contract_signed notification to internal_owner email
//     (or INTERNAL_CONTRACT_EMAILS fallback)

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("id, vendor_id, display_name").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id, email: data.user.email } : null;
  } catch { return null; }
}

function getContractId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const signIdx = parts.lastIndexOf("sign");
  return signIdx > 0 ? parts[signIdx - 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  const contractId = getContractId(req);
  if (!contractId) return res.status(400).json({ error: "Missing contract id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { file_url, file_name, file_size_bytes, file_mime_type } = body || {};
  if (!file_url) return res.status(400).json({ error: "file_url is required" });
  if (file_mime_type && !/^application\/pdf/i.test(file_mime_type)) return res.status(400).json({ error: "Only PDF files are allowed" });
  if (file_size_bytes && Number(file_size_bytes) > 20 * 1024 * 1024) return res.status(400).json({ error: "File exceeds 20MB limit" });
  // Path-injection guard — file_url must live under the caller's folder.
  // Without this, a vendor could "sign" their contract with another vendor's
  // file by submitting the other vendor's storage path here.
  if (typeof file_url !== "string" || !file_url.startsWith(`${caller.vendor_id}/`)) {
    return res.status(403).json({ error: "file_url must be under the caller's vendor folder" });
  }

  const { data: contract } = await admin
    .from("contracts")
    .select("id, vendor_id, title, contract_type, internal_owner, status")
    .eq("id", contractId).eq("vendor_id", caller.vendor_id).maybeSingle();
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  if (contract.status === "signed") return res.status(409).json({ error: "Contract is already signed" });
  if (["expired", "terminated"].includes(contract.status)) return res.status(409).json({ error: `Contract is ${contract.status}; cannot sign` });

  const nowIso = new Date().toISOString();
  // Filter on vendor_id too — defense in depth in case the row's owner
  // changed between the read above and the update below.
  const { error: updErr } = await admin.from("contracts").update({
    signed_file_url: file_url,
    signed_at: nowIso,
    signed_by_vendor: caller.id,
    status: "signed",
    updated_at: nowIso,
  }).eq("id", contractId).eq("vendor_id", caller.vendor_id);
  if (updErr) return res.status(500).json({ error: updErr.message });

  // Append as a new version
  const { data: maxV } = await admin
    .from("contract_versions")
    .select("version_number")
    .eq("contract_id", contractId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (maxV?.version_number || 0) + 1;

  await admin.from("contract_versions").insert({
    contract_id: contractId,
    version_number: nextVersion,
    file_url,
    notes: `Countersigned by ${caller.display_name || caller.email || "vendor"}`,
    uploaded_by_type: "vendor",
    uploaded_by_vendor_user_id: caller.id,
  });

  // Notification
  try {
    const origin = `https://${req.headers.host}`;
    const emails = new Set();
    if (contract.internal_owner && contract.internal_owner.includes("@")) emails.add(contract.internal_owner);
    for (const e of (process.env.INTERNAL_CONTRACT_EMAILS || process.env.INTERNAL_COMPLIANCE_EMAILS || "").split(",")) {
      const v = e.trim();
      if (v) emails.add(v);
    }
    const { data: vendor } = await admin.from("vendors").select("name").eq("id", caller.vendor_id).maybeSingle();
    const vendorName = vendor?.name || "A vendor";
    for (const email of emails) {
      fetch(`${origin}/api/send-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "contract_signed",
          title: `${vendorName} countersigned ${contract.title}`,
          body: `${vendorName} has signed the ${contract.contract_type.replace(/_/g, " ")} '${contract.title}'.`,
          link: "/",
          metadata: { contract_id: contract.id, vendor_id: caller.vendor_id },
          recipient: { internal_id: "contracts_team", email },
          dedupe_key: `contract_signed_${contract.id}_${email}`,
          email: true,
        }),
      }).catch(() => {});
    }
  } catch { /* non-blocking */ }

  return res.status(200).json({ ok: true, contract_id: contractId, version_number: nextVersion });
}
