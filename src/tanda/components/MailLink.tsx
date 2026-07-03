// src/tanda/components/MailLink.tsx
//
// Click-to-email affordance (operator ask — clicking an email opens a new
// message). Two shapes:
//   <MailLink email={x} />                — an "Email" link button, for sitting inside
//                                            an input wrapper (absolute, right).
//   <MailLink email={x}>{label}</MailLink> — a plain mailto: text link, for
//                                            table cells / read displays.
// The link is inert (greyed, no navigation) until the address looks valid.

import React from "react";

const C = { primary: "#3B82F6", textMuted: "#94A3B8" };
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function MailLink({ email, children }: { email: string | null | undefined; children?: React.ReactNode }) {
  const addr = String(email ?? "").trim();
  const ok = EMAIL_RE.test(addr);

  // Text-link form (table cell / display).
  if (children !== undefined) {
    if (!ok) return <>{children}</>;
    return (
      <a href={`mailto:${addr}`} title={`Email ${addr}`} onClick={(e) => e.stopPropagation()}
        style={{ color: C.primary, textDecoration: "none" }}>
        {children}
      </a>
    );
  }

  // Icon form (inside an input wrapper).
  return (
    <a
      href={ok ? `mailto:${addr}` : undefined}
      title={ok ? `Email ${addr}` : "Enter a valid email to enable"}
      onClick={(e) => { e.stopPropagation(); if (!ok) e.preventDefault(); }}
      style={{
        position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
        textDecoration: "none", fontSize: 14, lineHeight: 1,
        color: ok ? C.primary : C.textMuted, cursor: ok ? "pointer" : "default",
      }}
    >Email</a>
  );
}
