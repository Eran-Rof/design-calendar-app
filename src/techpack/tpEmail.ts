// Pure helpers for the TechPack email panel: the tracking-prefix
// (`[TP-…]`) that the Graph $search filter pivots on, the URL
// builders for inbox/thread/sent-folder queries, and the Graph
// sendMail payload shape.
//
// Extracted from TechPack.tsx so the prefix grammar + the exact
// $select column lists can be unit-tested. Subtle regressions
// (dropping a $select column, missing the Outlook "[TP-" check)
// silently break the inbox in the email panel — pinning them in
// tests catches them in CI rather than at the operator's desk.

import type { TechPack } from "./types";

/** Fields requested when listing inbox messages (id, subject, …). */
const INBOX_SELECT = "id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead,hasAttachments";

/** Fields requested when loading a single conversation thread. */
const THREAD_SELECT = "id,subject,from,receivedDateTime,body,conversationId,isRead,hasAttachments";

/** Fields requested when listing the SentItems folder. */
const SENT_SELECT = "id,subject,from,toRecipients,sentDateTime,bodyPreview,conversationId,hasAttachments";

/**
 * The tracking prefix used to group every Graph message + Teams chat
 * for a single tech pack. Pattern: `[TP-{styleNumber or 8-char id}]`.
 * Used as a $search term against Outlook subjects.
 */
export function tpEmailPrefix(tp: Pick<TechPack, "styleNumber" | "id">): string {
  return `[TP-${tp.styleNumber || tp.id.slice(0, 8)}]`;
}

/**
 * Build a Graph URL for the first 25 inbox messages matching the
 * given prefix in the subject line. Outlook's $search wants the
 * query wrapped in escaped double-quotes.
 */
export function buildInboxSearchUrl(prefix: string): string {
  return `/me/messages?$search=${encodeURIComponent('"' + prefix + '"')}&$top=25&$select=${INBOX_SELECT}`;
}

/** Build a Graph URL for every message in a single conversation, ascending. */
export function buildThreadUrl(convId: string): string {
  return `/me/messages?$filter=${encodeURIComponent("conversationId eq '" + convId + "'")}&$orderby=receivedDateTime%20asc&$select=${THREAD_SELECT}`;
}

/**
 * Build a Graph URL for the SentItems folder, scoped to the prefix.
 * Brackets/braces/parens/wildcards are stripped from the search
 * term — Outlook's $search rejects them.
 */
export function buildSentFolderSearchUrl(prefix: string): string {
  const searchTerm = prefix.replace(/[\[\]{}()*?]/g, "").trim();
  return `/me/mailFolders/SentItems/messages?$search=${encodeURIComponent('"' + searchTerm + '"')}&$top=25&$select=${SENT_SELECT}`;
}

export interface SendMailArgs {
  prefix: string;
  /** Optional operator-typed subject. */
  subject: string;
  /** Either a fallback (styleName | styleNumber) for the auto-subject. */
  fallback: string;
  /** Empty string → fills with a single space (Graph rejects empty bodies). */
  bodyHtml: string;
  /** Comma-separated emails; trimmed per address before send. */
  to: string;
}

/**
 * Build the JSON body for POST /me/sendMail. If `subject` is empty,
 * fall back to `"{prefix} {fallback}"`. If the operator-typed
 * subject already starts with `[TP-`, leave it alone; otherwise
 * prepend the prefix so the matching $search keeps working on
 * replies.
 */
export function buildSendMailPayload(args: SendMailArgs): { message: any } {
  const typed = args.subject.trim();
  let subject = typed || `${args.prefix} ${args.fallback}`;
  if (typed && !typed.startsWith("[TP-")) {
    subject = `${args.prefix} ${subject}`;
  }
  return {
    message: {
      subject,
      body: { contentType: "HTML", content: args.bodyHtml || " " },
      toRecipients: args.to.split(",").map(e => ({ emailAddress: { address: e.trim() } })),
    },
  };
}
