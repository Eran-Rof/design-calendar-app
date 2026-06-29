// After a customer/vendor is added "on the fly" from an order window (the short
// QuickAddPartyModal form, operator item 8), nudge the operator to complete the
// full master record later. Best-effort: reads the current operator from the PLM
// session and fires an in-app (+ email) notification via /api/send-notification.
// Never throws — a failed nudge must not block the order flow.

interface PlmUser { username?: string; email?: string; name?: string }

export async function notifyCompleteParty(
  kind: "customer" | "vendor",
  row: { id: string; name: string; customer_code?: string; code?: string },
): Promise<void> {
  try {
    const raw = sessionStorage.getItem("plm_user");
    const user = raw ? (JSON.parse(raw) as PlmUser) : null;
    const recipient: Record<string, string> = {};
    if (user?.username) recipient.internal_id = user.username;
    if (user?.email) recipient.email = user.email;
    if (!recipient.internal_id && !recipient.email) return; // no one to notify

    const code = row.customer_code || row.code || "";
    const masterKey = kind === "customer" ? "customer_master" : "vendor_master";
    const masterLabel = kind === "customer" ? "Customer Master" : "Vendor Master";

    await fetch("/api/send-notification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "party_incomplete",
        title: `Complete the new ${kind}: ${row.name}`,
        body: `"${row.name}"${code ? ` (${code})` : ""} was added on the fly with only the basics. Open ${masterLabel} to fill in terms, GL routing, addresses and contacts.`,
        link: `/tangerine?m=${masterKey}&q=${encodeURIComponent(code || row.name)}`,
        recipient,
        email: !!recipient.email,
        dedupe_key: `party_incomplete:${row.id}`,
      }),
    });
  } catch {
    /* best-effort — never block the order on a nudge failure */
  }
}
