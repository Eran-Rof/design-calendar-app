// api/vendor/compliance/index.js
//
// GET  — returns all document types grouped by vendor status:
//          { complete, expiring_soon, missing, rejected }
//        expiring_soon = approved with expiry_date within next 60 days
//
// POST — submits a compliance document.
//        body: { document_type_id, expiry_date?, issued_at?, notes?,
//                file_url (Supabase Storage path),
//                file_name, file_size_bytes, file_mime_type }
//
//        The client uploads the file directly to bucket 'vendor-docs' first
//        (RLS confines them to <vendor_id>/...). This endpoint validates
//        the metadata, creates the compliance_documents row with status
//        'pending_review', and fires an internal notification.
//        File size cap: 20MB; MIME must be application/pdf or image/*.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin
      .from("vendor_users")
      .select("id, vendor_id, display_name")
      .eq("auth_id", data.user.id)
      .maybeSingle();
    if (!vu) return null;
    return { ...vu, auth_id: data.user.id, email: data.user.email };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  if (req.method === "GET") {
    const [typesRes, docsRes] = await Promise.all([
      admin.from("compliance_document_types").select("*").eq("active", true).order("sort_order"),
      admin.from("compliance_documents")
        .select("*, document_type:compliance_document_types(id,name,code,required,expiry_required)")
        .eq("vendor_id", caller.vendor_id)
        .order("uploaded_at", { ascending: false }),
    ]);
    if (typesRes.error) return res.status(500).json({ error: typesRes.error.message });
    if (docsRes.error)  return res.status(500).json({ error: docsRes.error.message });

    const types = typesRes.data || [];
    const docs = docsRes.data || [];

    // Latest doc per type
    const byType = new Map();
    for (const d of docs) {
      const prev = byType.get(d.document_type_id);
      if (!prev || new Date(d.uploaded_at) > new Date(prev.uploaded_at)) byType.set(d.document_type_id, d);
    }

    const now = new Date();
    const in60 = new Date(now.getTime() + 60 * 86_400_000);
    const groups = { complete: [], expiring_soon: [], missing: [], rejected: [] };

    for (const t of types) {
      const doc = byType.get(t.id);
      if (!doc) {
        if (t.required) groups.missing.push({ document_type: t, document: null });
        continue;
      }
      if (doc.status === "rejected") {
        groups.rejected.push({ document_type: t, document: doc });
        continue;
      }
      if (doc.status === "approved" && doc.expiry_date) {
        const exp = new Date(doc.expiry_date);
        if (exp < now) {
          if (t.required) groups.missing.push({ document_type: t, document: { ...doc, status: "expired" } });
          continue;
        }
        if (exp < in60) { groups.expiring_soon.push({ document_type: t, document: doc }); continue; }
      }
      if (doc.status === "approved" || doc.status === "pending_review") {
        groups.complete.push({ document_type: t, document: doc });
      } else if (doc.status === "expired") {
        if (t.required) groups.missing.push({ document_type: t, document: doc });
      }
    }

    return res.status(200).json(groups);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const {
      document_type_id, expiry_date, issued_at, notes,
      file_url, file_name, file_size_bytes, file_mime_type,
    } = body || {};
    if (!document_type_id) return res.status(400).json({ error: "document_type_id is required" });
    if (!file_url)         return res.status(400).json({ error: "file_url (Supabase Storage path) is required" });

    if (file_mime_type && !/^(application\/pdf|image\/)/i.test(file_mime_type)) {
      return res.status(400).json({ error: "Only PDF or image files are allowed" });
    }
    if (file_size_bytes && Number(file_size_bytes) > 20 * 1024 * 1024) {
      return res.status(400).json({ error: "File exceeds 20MB limit" });
    }

    const { data: type } = await admin
      .from("compliance_document_types")
      .select("id, name, expiry_required")
      .eq("id", document_type_id).eq("active", true).maybeSingle();
    if (!type) return res.status(400).json({ error: "Unknown or inactive document_type_id" });
    if (type.expiry_required && !expiry_date) return res.status(400).json({ error: `${type.name} requires an expiry_date` });

    const { data: doc, error: insErr } = await admin.from("compliance_documents").insert({
      vendor_id: caller.vendor_id,
      document_type_id,
      file_url,
      file_name: file_name || null,
      file_size_bytes: file_size_bytes ? Number(file_size_bytes) : null,
      file_mime_type: file_mime_type || null,
      issued_at: issued_at || null,
      expiry_date: expiry_date || null,
      status: "pending_review",
      uploaded_by: caller.id,
      notes: notes ? String(notes).trim() : null,
    }).select("*").single();
    if (insErr) return res.status(500).json({ error: insErr.message });

    // Notify each internal compliance team member (email-only).
    // INTERNAL_COMPLIANCE_EMAILS is a comma-separated list of addresses
    // set in Vercel env vars.
    try {
      const emails = (process.env.INTERNAL_COMPLIANCE_EMAILS || "")
        .split(",").map((e) => e.trim()).filter(Boolean);
      if (emails.length > 0) {
        const { data: vendor } = await admin.from("vendors").select("name").eq("id", caller.vendor_id).maybeSingle();
        const vendorName = vendor?.name || "A vendor";
        const origin = `https://${req.headers.host}`;
        await Promise.all(emails.map((email) =>
          fetch(`${origin}/api/send-notification`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event_type: "compliance_doc_submitted",
              title: `${vendorName} submitted ${type.name}`,
              body: `${vendorName} has uploaded a ${type.name} for compliance review. Open the internal TandA Compliance tab to review.`,
              link: "/",
              recipient: { internal_id: "compliance_team", email },
              dedupe_key: `compliance_doc_submitted_${doc.id}_${email}`,
              email: true,
            }),
          }).catch(() => {})
        ));
      }
    } catch { /* non-blocking */ }

    return res.status(201).json(doc);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
