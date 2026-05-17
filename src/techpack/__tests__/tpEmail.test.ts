// Tests for the TechPack email prefix + Graph URL/payload builders.
// The inbox panel depends on Outlook's $search matching the exact
// `[TP-…]` prefix, so the grammar + the URL encoding of those
// queries needs to stay locked. This is what the suite pins.

import { describe, it, expect } from "vitest";
import {
  tpEmailPrefix,
  buildInboxSearchUrl,
  buildThreadUrl,
  buildSentFolderSearchUrl,
  buildSendMailPayload,
} from "../tpEmail";

// ────────────────────────────────────────────────────────────────────────

describe("tpEmailPrefix", () => {
  it("uses the styleNumber when present", () => {
    expect(tpEmailPrefix({ styleNumber: "RYB059430", id: "abc12345xyz" })).toBe("[TP-RYB059430]");
  });

  it("falls back to first 8 chars of the id when no styleNumber", () => {
    expect(tpEmailPrefix({ styleNumber: "", id: "abc12345xyz789" })).toBe("[TP-abc12345]");
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("buildInboxSearchUrl", () => {
  const url = buildInboxSearchUrl("[TP-RYB001]");

  it("targets /me/messages with $search wrapped in quotes (url-encoded)", () => {
    // %22 is the encoded double-quote
    expect(url).toContain("/me/messages?$search=%22");
    expect(url).toContain("%22&$top=25");
  });

  it("requests the inbox $select columns the renderer reads", () => {
    expect(url).toContain("id");
    expect(url).toContain("subject");
    expect(url).toContain("from");
    expect(url).toContain("receivedDateTime");
    expect(url).toContain("bodyPreview");
    expect(url).toContain("conversationId");
    expect(url).toContain("isRead");
    expect(url).toContain("hasAttachments");
  });

  it("includes the literal prefix (encoded) in the query", () => {
    expect(url).toContain(encodeURIComponent('"[TP-RYB001]"'));
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("buildThreadUrl", () => {
  const url = buildThreadUrl("conv-123-XYZ");

  it("filters by conversationId + orders ascending", () => {
    expect(url).toContain("/me/messages?$filter=");
    expect(url).toContain("$orderby=receivedDateTime%20asc");
    expect(url).toContain(encodeURIComponent("conversationId eq 'conv-123-XYZ'"));
  });

  it("requests the body column (thread reader renders full HTML)", () => {
    expect(url).toContain(",body,");
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("buildSentFolderSearchUrl", () => {
  it("targets the SentItems folder + drops bracket noise from the prefix", () => {
    const url = buildSentFolderSearchUrl("[TP-RYB001]");
    expect(url).toContain("/me/mailFolders/SentItems/messages?$search=");
    // [ and ] should be stripped before being url-encoded
    expect(url).toContain(encodeURIComponent('"TP-RYB001"'));
    expect(url).not.toContain(encodeURIComponent("[TP-"));
  });

  it("includes toRecipients + sentDateTime in the $select columns", () => {
    const url = buildSentFolderSearchUrl("[TP-X]");
    expect(url).toContain("toRecipients");
    expect(url).toContain("sentDateTime");
  });
});

// ────────────────────────────────────────────────────────────────────────

describe("buildSendMailPayload", () => {
  it("falls back to `{prefix} {fallback}` when subject is empty", () => {
    const { message } = buildSendMailPayload({
      prefix: "[TP-RYB001]", subject: "", fallback: "Edge Slim",
      bodyHtml: "Hi", to: "a@x.com",
    });
    expect(message.subject).toBe("[TP-RYB001] Edge Slim");
  });

  it("prepends the prefix when operator subject does not start with [TP-", () => {
    const { message } = buildSendMailPayload({
      prefix: "[TP-RYB001]", subject: "Reorder", fallback: "Edge Slim",
      bodyHtml: "x", to: "a@x.com",
    });
    expect(message.subject).toBe("[TP-RYB001] Reorder");
  });

  it("leaves operator subject alone when it already starts with [TP-", () => {
    const { message } = buildSendMailPayload({
      prefix: "[TP-RYB001]", subject: "[TP-RYB001] Re: Reorder",
      fallback: "Edge Slim", bodyHtml: "x", to: "a@x.com",
    });
    expect(message.subject).toBe("[TP-RYB001] Re: Reorder");
  });

  it("replaces an empty body with a single space (Graph rejects empty)", () => {
    const { message } = buildSendMailPayload({
      prefix: "p", subject: "[TP-1] s", fallback: "", bodyHtml: "", to: "a@x.com",
    });
    expect(message.body).toEqual({ contentType: "HTML", content: " " });
  });

  it("trims + splits comma-separated recipients", () => {
    const { message } = buildSendMailPayload({
      prefix: "p", subject: "[TP-1] s", fallback: "",
      bodyHtml: "x", to: " a@x.com , b@y.com,c@z.com ",
    });
    expect(message.toRecipients).toEqual([
      { emailAddress: { address: "a@x.com" } },
      { emailAddress: { address: "b@y.com" } },
      { emailAddress: { address: "c@z.com" } },
    ]);
  });

  it("preserves HTML body content as-is", () => {
    const { message } = buildSendMailPayload({
      prefix: "p", subject: "[TP-1] s", fallback: "",
      bodyHtml: "<p>Hello</p>", to: "a@x.com",
    });
    expect(message.body.content).toBe("<p>Hello</p>");
  });
});
