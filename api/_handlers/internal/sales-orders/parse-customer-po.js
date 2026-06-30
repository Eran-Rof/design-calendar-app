// api/internal/sales-orders/parse-customer-po
//
// POST — read an uploaded CUSTOMER purchase-order document and extract the
// structured fields needed to pre-fill a new Sales Order. The document can be a
// PDF, an Excel/CSV workbook, or plain text (a pasted email body). The model
// (Claude Sonnet) returns header fields + a line list; the SO modal then matches
// the customer / terms / styles to our masters and pre-fills the size matrix.
// Advisory only — the operator confirms everything before saving.
//
// body (one of):
//   { filename: "po.pdf",  base64: "<...>" }   // PDF
//   { filename: "po.xlsx", base64: "<...>" }   // Excel (.xlsx/.xls) or .csv
//   { text: "<pasted email body>" }            // plain text / email
//
// Response: { parsed: { customer_name, customer_po_number, payment_terms,
//   start_ship_date, cancel_date, currency, lines: [{ style_code, color,
//   description, unit_price, total_qty, size_breakdown:[{size,qty}]|null }] } }

import Anthropic from "@anthropic-ai/sdk";
import * as XLSX from "xlsx";

export const config = { maxDuration: 60 };

const MODEL = "claude-sonnet-4-6";

const PO_SCHEMA = {
  type: "object",
  properties: {
    customer_name: { type: ["string", "null"] },
    customer_po_number: { type: ["string", "null"] },
    payment_terms: { type: ["string", "null"] },
    start_ship_date: { type: ["string", "null"] },
    cancel_date: { type: ["string", "null"] },
    currency: { type: "string" },
    // How the order is fulfilled: "ats" (ship from existing stock) or "production"
    // (make it). null when the text gives no instruction.
    fulfillment_source: { type: ["string", "null"] },
    // True when the sender asks to use a PLACEHOLDER / temporary PO number (or
    // says "no PO yet" / "PO to follow"). When true, customer_po_number MUST be
    // null — the app generates its own placeholder; never invent one.
    use_placeholder_po: { type: "boolean" },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          style_code: { type: ["string", "null"] },
          color: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
          unit_price: { type: ["number", "null"] },
          total_qty: { type: ["number", "null"] },
          // True when total_qty is a count of PACKS / PREPACKS / CARTONS rather
          // than individual units (common for prepack/PPK styles).
          qty_is_packs: { type: "boolean" },
          size_breakdown: {
            type: ["array", "null"],
            items: {
              type: "object",
              properties: { size: { type: "string" }, qty: { type: "number" } },
              required: ["size", "qty"],
              additionalProperties: false,
            },
          },
        },
        required: ["style_code", "color", "description", "unit_price", "total_qty", "qty_is_packs", "size_breakdown"],
        additionalProperties: false,
      },
    },
  },
  required: ["customer_name", "customer_po_number", "payment_terms", "start_ship_date", "cancel_date", "currency", "fulfillment_source", "use_placeholder_po", "lines"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You extract structured data from a CUSTOMER's purchase order for an apparel wholesaler.

The document is a purchase order the customer (a retailer / distributor) sent to us, the apparel vendor. Extract the order header and the ordered styles.

Rules:
- NEVER fabricate. If a field is genuinely absent, return null.
- Dates must be ISO 8601 (YYYY-MM-DD). If you can't read a full date, return null. "Start ship" / "ship date" / "ship window start" → start_ship_date. "Cancel" / "do not ship after" / "ship window end" → cancel_date.
- currency = 3-letter ISO 4217 (USD, EUR, GBP, CAD, …); default "USD".
- customer_po_number = the customer's own PO number / order number for this order.
- use_placeholder_po = true ONLY when the sender explicitly asks to use a placeholder / temporary / dummy PO number, or says the PO is "to follow" / "not yet assigned" / there is no PO number. When true, set customer_po_number to null — do NOT invent a number. Otherwise false.
- fulfillment_source = "production" when the order should be MADE (e.g. "from production", "make it", "produce", "cut & sew", "manufacture"); "ats" when it ships from existing stock (e.g. "from stock", "available to ship", "ATS", "quick ship", "ex-stock"); null when the text says nothing about how to fulfill it.
- customer_name = the buyer / retailer placing the order (NOT our company).
- payment_terms = normalize to "Net N" form. "30 DAYS" / "30 days" / "Net 30" / "N30" all → "Net 30"; "60 DAYS" → "Net 60". Keep an early-payment discount prefix if present (e.g. "2/10 Net 30"). Null if absent.
- For each ordered style return one line. style_code = the style number / item number ONLY (often our style code like RYB0594, or RYB0594PPK for a prepack). color = the color/colorway if given.
- IMPORTANT: customer item codes often glue the style and color together, e.g. "RYB187810-OPEN SEA", "RYB0594/RED", "RYB0594 BLACK". In that case put ONLY the leading style number in style_code (e.g. "RYB187810") and the trailing color text in color (e.g. "OPEN SEA"). Do not return the combined string as style_code. description = the product description.
- unit_price = the per-unit selling price / unit cost as a plain NUMBER (strip $, commas). On tabular POs this is the "UNIT COST" or "PRICE" column.
- total_qty = the total quantity ordered for that style+color, as a plain NUMBER (strip commas). On tabular POs this is the "ORDER QTY" (or "TOTAL QTY") column — e.g. "2,304" → 2304. Never put a word here; it must be numeric.
- qty_is_packs = true when total_qty counts PACKS / PREPACKS / CARTONS (e.g. "20 prepacks", "20 packs", "12 cartons" → total_qty 20/20/12 and qty_is_packs true). false when total_qty counts individual units / eaches. Default false.
- size_breakdown = the per-size quantities ONLY IF the PO lists an actual size run (e.g. S 12, M 24, L 24, XL 12), using the size labels as printed. If the size is shown as "AST", "ASST", "ASSORTED", "PREPACK", "NESTED", or there's no real per-size split, return null for size_breakdown and put the number in total_qty — those are assorted/prepack orders, NOT a size called "AST".
- If a style is ordered in multiple colors, return one line per color.
- Return JSON exactly matching the schema — no prose.`;

function buildContent({ kind, base64, text, mediaType }) {
  if (kind === "pdf") {
    return [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
      { type: "text", text: "Extract the purchase-order fields from this document." },
    ];
  }
  if (kind === "excel") {
    const wb = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer" });
    const parts = [];
    for (const name of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
      parts.push(`=== Sheet: ${name} ===\n${csv}`);
    }
    return [{ type: "text", text: `CSV representation of the customer's PO spreadsheet. Extract the fields.\n\n${parts.join("\n\n")}` }];
  }
  // text / email / csv
  return [{ type: "text", text: `The following is the text of a customer's purchase order (it may be an email body or a CSV export). Extract the fields.\n\n${text}` }];
  void mediaType;
}

function parseJson(resp) {
  const block = (resp.content || []).find((b) => b.type === "text");
  if (!block) throw new Error("Model returned no text block");
  try { return JSON.parse(block.text); }
  catch (e) { throw new Error(`Model did not return valid JSON: ${e.message}`); }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "Server not configured (ANTHROPIC_API_KEY missing)" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const base64 = typeof body.base64 === "string" ? body.base64 : "";
  const filename = typeof body.filename === "string" ? body.filename : "";
  const ext = (filename.split(".").pop() || "").toLowerCase();

  let kind;
  if (base64) {
    if (ext === "pdf") kind = "pdf";
    else if (ext === "xlsx" || ext === "xls") kind = "excel";
    else if (ext === "csv" || ext === "txt" || ext === "eml") {
      // decode the base64 text payload and treat as plain text
      body.text = Buffer.from(base64, "base64").toString("utf8");
      kind = "text";
    } else return res.status(400).json({ error: `Unsupported file type: .${ext}. Use pdf, xlsx, xls, csv, txt, or paste the email text.` });
  } else if (text) {
    kind = "text";
  } else {
    return res.status(400).json({ error: "Provide a file (base64 + filename) or text." });
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  try {
    const content = buildContent({ kind, base64, text: body.text || text });
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: PO_SCHEMA } },
      messages: [{ role: "user", content }],
    });
    const parsed = parseJson(resp);
    if (!Array.isArray(parsed.lines)) parsed.lines = [];
    return res.status(200).json({ parsed });
  } catch (e) {
    if (e instanceof Anthropic.APIError) return res.status(502).json({ error: `Anthropic API error (${e.status}): ${e.message}` });
    return res.status(500).json({ error: String(e.message || e) });
  }
}
