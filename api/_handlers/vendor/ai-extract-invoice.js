// api/vendor/ai-extract-invoice
//
// POST — read an already-uploaded invoice document (PDF or Excel) from
// the vendor-docs Supabase bucket and extract structured fields with
// Claude. Returns a pre-fill payload the client can hand to the
// invoice submission form so the user only has to review & confirm.
//
// body: { file_url: "<vendor_id>/invoices/<path>", po_id: "<uuid>" }
//
// Response: {
//   extracted: {
//     invoice_number, invoice_date, due_date, currency, notes,
//     line_items: [{ description, quantity_invoiced, unit_price, item_number }]
//   }
// }

import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import * as XLSX from "xlsx";
import { authenticateVendor } from "../../_lib/vendor-auth.js";

export const config = { maxDuration: 60 };

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    invoice_number: { type: ["string", "null"] },
    invoice_date: { type: ["string", "null"] },
    due_date: { type: ["string", "null"] },
    currency: { type: "string" },
    notes: { type: ["string", "null"] },
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: ["string", "null"] },
          quantity_invoiced: { type: ["number", "null"] },
          unit_price: { type: ["number", "null"] },
          item_number: { type: ["string", "null"] },
        },
        required: ["description", "quantity_invoiced", "unit_price", "item_number"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "invoice_number", "invoice_date", "due_date",
    "currency", "notes", "line_items",
  ],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You extract structured invoice data from attached documents.

Rules:
- Never fabricate. If a field is genuinely missing from the document, return null.
- Dates must be ISO 8601 (YYYY-MM-DD). If you can only read a partial date, return null.
- currency must be a 3-letter ISO 4217 code (USD, EUR, GBP, CNY, HKD, INR). Default to "USD" if not indicated.
- quantity_invoiced and unit_price must be plain numbers — strip currency symbols, commas, and units.
- line_items must mirror the order they appear on the invoice.
- Return JSON exactly matching the schema — no prose.`;

async function extractFromPdf(client, pdfBase64) {
  const resp = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: {
      format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
    },
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
        { type: "text", text: "Extract the invoice fields from this document." },
      ],
    }],
  });
  return parseJson(resp);
}

function excelToText(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const out = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    // CSV conversion keeps row/column structure readable for the model.
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    out.push(`=== Sheet: ${sheetName} ===\n${csv}`);
  }
  return out.join("\n\n");
}

async function extractFromExcel(client, buffer) {
  const text = excelToText(buffer);
  const resp = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: {
      format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
    },
    messages: [{
      role: "user",
      content: [{
        type: "text",
        text: `The following is the CSV representation of an invoice spreadsheet. Extract the invoice fields.\n\n${text}`,
      }],
    }],
  });
  return parseJson(resp);
}

function parseJson(resp) {
  const textBlock = (resp.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Model returned no text block");
  try {
    return JSON.parse(textBlock.text);
  } catch (e) {
    throw new Error(`Model did not return valid JSON: ${e.message}`);
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured (Supabase)" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "Server not configured (ANTHROPIC_API_KEY missing)" });

  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req, { requiredScope: "invoices:write" });
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });
  const { auth, finish } = authRes;
  const vendorId = auth.vendor_id;
  const send = (code, payload) => { finish?.(code); return res.status(code).json(payload); };

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return send(400, { error: "Invalid JSON" }); } }
  const { file_url } = body || {};
  if (!file_url || typeof file_url !== "string") return send(400, { error: "file_url is required" });
  // Enforce: must be under this vendor's folder in vendor-docs.
  if (!file_url.startsWith(`${vendorId}/`)) return send(403, { error: "file_url does not belong to the caller's vendor" });

  // Download file bytes with the service role (bypasses bucket RLS).
  const { data: blob, error: dlErr } = await admin.storage.from("vendor-docs").download(file_url);
  if (dlErr || !blob) return send(404, { error: `Could not download file: ${dlErr?.message || "unknown"}` });
  const arrayBuf = await blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);

  const ext = (file_url.split(".").pop() || "").toLowerCase();
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  try {
    let extracted;
    if (ext === "pdf") {
      extracted = await extractFromPdf(client, buffer.toString("base64"));
    } else if (ext === "xlsx" || ext === "xls") {
      extracted = await extractFromExcel(client, buffer);
    } else {
      return send(400, { error: `Unsupported file type: .${ext}. Must be pdf / xls / xlsx.` });
    }
    return send(200, { extracted });
  } catch (e) {
    if (e instanceof Anthropic.APIError) {
      return send(502, { error: `Anthropic API error (${e.status}): ${e.message}` });
    }
    return send(500, { error: String(e.message || e) });
  }
}
