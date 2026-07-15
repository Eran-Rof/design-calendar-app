// P28-4-2 capability pack — Email drafts (compose-only, writes NOTHING).
//
// Two actions: draft_vendor_email + draft_customer_email. Both are mode:"read"
// (arch action (d)) — a pure text composer that returns a CEO-copyable draft
// (subject + body). There is NO send, NO DB write, NO token: read-mode actions
// return their preview() directly and never reach a commit() (there is none).
//
// This matches the CEO-not-admin rule (the assistant drafts; the CEO copies and
// sends from their own mailbox) and the no-auto-send guardrail (arch section 8).
//
// Pure/deterministic — no admin client is used; unit-tested directly.

/** Collapse a free-text recipient to a safe single line. */
function cleanLine(s, max = 160) {
  return (s == null ? "" : String(s)).replace(/\s+/g, " ").trim().slice(0, max);
}

/** Normalise key_facts (string | string[]) into trimmed non-empty lines. */
function factLines(facts) {
  const arr = Array.isArray(facts) ? facts : facts == null ? [] : String(facts).split(/\r?\n/);
  return arr.map((f) => cleanLine(f, 240)).filter(Boolean).slice(0, 12);
}

/**
 * Compose one draft. Party = "vendor" | "customer" — only tunes the salutation
 * fallback and sign-off context; the body is otherwise identical.
 */
export function composeDraft(party, input) {
  const recipient = cleanLine(input?.recipient) || (party === "vendor" ? "Supplier" : "Customer");
  const topic = cleanLine(input?.topic, 120) || "a quick note";
  const facts = factLines(input?.key_facts);

  const subject = topic.length <= 78 ? topic : `${topic.slice(0, 75)}...`;

  const lines = [];
  lines.push(`Hi ${recipient},`);
  lines.push("");
  lines.push(`I wanted to reach out regarding ${topic}.`);
  if (facts.length) {
    lines.push("");
    for (const f of facts) lines.push(`- ${f}`);
  }
  lines.push("");
  lines.push(
    party === "vendor"
      ? "Please let me know if you need anything from us to move this forward."
      : "Please let me know if you have any questions or need anything else from us.",
  );
  lines.push("");
  lines.push("Best regards,");
  lines.push("Ring of Fire Clothing");

  const body = lines.join("\n");
  const who = party === "vendor" ? "vendor" : "customer";
  return {
    summary: `Drafted a ${who} email to ${recipient} about ${topic}. Copy it into your mailbox to send — nothing was sent or saved.`,
    draft: { to: recipient, subject, body },
    warnings: [],
  };
}

const EMAIL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    recipient: { type: "string", description: "Who the email is addressed to (name or company)." },
    topic: { type: "string", description: "One-line subject / what the email is about." },
    key_facts: {
      description: "The points to include, as a list or newline-separated text.",
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    },
  },
  required: ["recipient", "topic"],
};

const draftVendorEmail = {
  name: "draft_vendor_email",
  label: "Draft a vendor email",
  module_key: "finance_misc",
  mode: "read",
  description: "Compose a copyable draft email to a vendor/supplier from a topic and key facts. Nothing is sent or stored.",
  input_schema: EMAIL_INPUT_SCHEMA,
  async preview(_admin, input, _ctx) {
    return composeDraft("vendor", input);
  },
};

const draftCustomerEmail = {
  name: "draft_customer_email",
  label: "Draft a customer email",
  module_key: "finance_misc",
  mode: "read",
  description: "Compose a copyable draft email to a customer from a topic and key facts. Nothing is sent or stored.",
  input_schema: EMAIL_INPUT_SCHEMA,
  async preview(_admin, input, _ctx) {
    return composeDraft("customer", input);
  },
};

export default {
  key: "email_drafts",
  label: "Email drafts",
  module_keys: ["finance_misc"],
  panels: {},
  actions: [draftVendorEmail, draftCustomerEmail],
};
