// api/internal/tpl-providers/test-connection
//
// POST { id }  — test a 3PL provider's SFTP EDI connection: connect + list the
// configured outbound (and inbound) directories. Returns a clean structured
// result for the "Test connection" button, including a graceful "no credentials
// configured" state when the secret / host isn't set yet.
//
// The stored secret (edi_secret_ciphertext) is decrypted server-side inside the
// transport layer; it is never returned to the client.

import { createClient } from "@supabase/supabase-js";
import { testConnection } from "../../../_lib/edi/transport.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const id = String(body.id || "");
  if (!UUID_RE.test(id)) return res.status(400).json({ error: "provider id (uuid) required" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: provider, error } = await admin
    .from("tpl_providers")
    .select("id, name, edi_protocol, edi_endpoint, edi_port, edi_username, edi_credential_ref, edi_secret_ciphertext, edi_outbound_dir, edi_inbound_dir, edi_archive_dir")
    .eq("id", id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!provider) return res.status(404).json({ error: "3PL provider not found" });

  const result = await testConnection(provider);
  return res.status(200).json({ ok: result.ok, detail: result.detail, dirs: result.dirs || null });
}
