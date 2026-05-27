// api/internal/documents/:id/signed-url
//
// GET — generate a short-lived signed download URL for the current version
//        (or a specific version via ?version_id=).
//        Query: ?ttl=N (default 300, max 3600 seconds)
//
// Tangerine P2 Chunk 6.

import { createClient } from "@supabase/supabase-js";
import { signedUrl, DocumentsError } from "../../../_lib/documents/index.js";

export const config = { maxDuration: 10 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const id = params?.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const versionId = url.searchParams.get("version_id") || null;
  let ttl = parseInt(url.searchParams.get("ttl") || "300", 10);
  if (Number.isNaN(ttl) || ttl < 30) ttl = 300;
  if (ttl > 3600) ttl = 3600;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  try {
    const out = await signedUrl(admin, {
      document_id: id, version_id: versionId, ttl_seconds: ttl,
    });
    return res.status(200).json(out);
  } catch (err) {
    if (err instanceof DocumentsError) {
      const status = err.code === "document_not_found" || err.code === "version_not_found" ? 404 : 500;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: err.message || String(err) });
  }
}
