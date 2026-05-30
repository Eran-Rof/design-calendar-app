// api/internal/procurement/invoices/[id]/bookkeeper-approve
//
// Tangerine P13-3 — STUB returning 501. P13-4 will implement the real
// bookkeeper approval workflow:
//   - flip invoices.status: 'pending_bookkeeper_approval' → 'approved'
//   - invoke P3 AP posting service to post the JE
//   - support rejection with required reason (status='rejected')
//
// For now, the handler exists so the routes table + UI can wire to it
// in P13-3 (the UI displays the Approve button, and clicking it gets a
// 501 with a "Not implemented — P13-4" message).

export const config = { maxDuration: 5 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid invoice id" });
  }

  return res.status(501).json({
    error: "Not implemented",
    detail: "Bookkeeper approval workflow ships in Tangerine P13-4. " +
            "This stub (h499) is reserved so the routes table + UI can wire " +
            "to the eventual endpoint. The P13-4 implementation will flip " +
            "invoices.status to 'approved' and invoke the P3 AP posting service.",
    invoice_id: id,
    chunk: "P13-4",
  });
}
