// api/internal/documents
//
// GET — list documents for a (context_table, context_id) under the default
//       entity. Returns metadata + current_version inline.
//       Query: ?context_table=<str>&context_id=<uuid>&include_archived=true|false
// POST — multipart/form-data upload of a new document.
//        Required fields: context_table, context_id, kind, title, file
//        Optional: notes
//
// Tangerine P2 Chunk 6.

import { createClient } from "@supabase/supabase-js";
import { attach, list, DocumentsError } from "../../../_lib/documents/index.js";

export const config = { maxDuration: 60 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const contextTable = (url.searchParams.get("context_table") || "").trim();
    const contextId = (url.searchParams.get("context_id") || "").trim();
    const includeArchived = url.searchParams.get("include_archived") === "true";
    if (!contextTable || !contextId) {
      return res.status(400).json({ error: "context_table and context_id are required" });
    }
    try {
      const rows = await list(admin, {
        entity_id: entityId, context_table: contextTable, context_id: contextId,
        include_archived: includeArchived,
      });
      return res.status(200).json(rows);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "POST") {
    // Vercel + Node: req.body for multipart is parsed by the runtime if
    // content-type contains "multipart/form-data" - but we receive raw
    // here. Use the busboy-free approach: clients send JSON with base64-
    // encoded bytes for MVP simplicity.
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateUploadBody(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    let buf;
    try {
      buf = Buffer.from(v.data.bytes_base64, "base64");
    } catch (e) {
      return res.status(400).json({ error: "bytes_base64 could not be decoded" });
    }
    if (buf.byteLength === 0) {
      return res.status(400).json({ error: "Decoded file is empty" });
    }
    if (buf.byteLength > 25 * 1024 * 1024) {
      return res.status(400).json({ error: "File too large (max 25MB in MVP)" });
    }

    try {
      const out = await attach(admin,
        {
          entity_id: entityId,
          context_table: v.data.context_table,
          context_id: v.data.context_id,
          kind: v.data.kind,
          title: v.data.title,
          created_by_user_id: v.data.created_by_user_id,
        },
        buf,
        { mime: v.data.mime, notes: v.data.notes, original_filename: v.data.original_filename });
      return res.status(201).json(out);
    } catch (err) {
      if (err instanceof DocumentsError) {
        return res.status(500).json({ error: err.message, code: err.code });
      }
      return res.status(500).json({ error: err.message || String(err) });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateUploadBody(body) {
  if (!body.context_table || !String(body.context_table).trim()) {
    return { error: "context_table required" };
  }
  if (!body.context_id || !/^[0-9a-f-]{36}$/i.test(body.context_id)) {
    return { error: "context_id (uuid) required" };
  }
  if (!body.kind || !String(body.kind).trim()) {
    return { error: "kind required" };
  }
  if (!body.title || !String(body.title).trim()) {
    return { error: "title required" };
  }
  if (!body.bytes_base64 || typeof body.bytes_base64 !== "string") {
    return { error: "bytes_base64 (base64 string) required" };
  }
  if (!body.mime || typeof body.mime !== "string") {
    return { error: "mime required" };
  }
  return {
    data: {
      context_table: String(body.context_table).trim(),
      context_id: body.context_id,
      kind: String(body.kind).trim(),
      title: String(body.title).trim(),
      mime: body.mime,
      bytes_base64: body.bytes_base64,
      notes: body.notes ? String(body.notes) : null,
      // Original client-side filename — used as the download (Content-
      // Disposition) name so files keep their real name (e.g. Q3-costing.xlsx)
      // rather than the storage basename vN.ext. Falls back to title.
      original_filename: body.original_filename
        ? String(body.original_filename).trim()
        : (body.title ? String(body.title).trim() : null),
      created_by_user_id: body.created_by_user_id || null,
    },
  };
}
