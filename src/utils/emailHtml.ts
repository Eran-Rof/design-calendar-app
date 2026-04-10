// Injects clean, readable CSS into raw email HTML for display in iframes,
// and optionally rewrites Outlook-style cid: image references to inline
// data URLs using the message's fetched inline attachments.
export interface InlineAttachment {
  contentId?: string;
  name?: string;
  contentType?: string;
  contentBytes?: string;
  isInline?: boolean;
}

function rewriteCidImages(html: string, inline: InlineAttachment[]): string {
  if (!inline || inline.length === 0) return html;
  // Build a lookup table by both contentId and name (Outlook sometimes uses
  // either as the cid value).
  const byId = new Map<string, InlineAttachment>();
  for (const a of inline) {
    if (!a.contentBytes) continue;
    if (a.contentId) byId.set(a.contentId.toLowerCase(), a);
    if (a.name) byId.set(a.name.toLowerCase(), a);
  }
  return html.replace(/(["'])cid:([^"']+)\1/gi, (match, quote, cid) => {
    const att = byId.get(cid.toLowerCase());
    if (!att || !att.contentBytes) return match;
    return `${quote}data:${att.contentType || "image/png"};base64,${att.contentBytes}${quote}`;
  });
}

export function styledEmailHtml(raw: string, inlineAttachments: InlineAttachment[] = []): string {
  const css = `<style>
    *{box-sizing:border-box}
    html,body{margin:0;padding:0}
    body{font-family:'Segoe UI','Aptos','Calibri',-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;line-height:1.55;color:#1f2328;background:#ffffff;padding:18px 22px;word-wrap:break-word;max-width:100%;overflow-x:auto}
    img{max-width:100%;height:auto;border-radius:2px}
    a{color:#0078D4;text-decoration:underline}
    a:hover{color:#106EBE}
    table{max-width:100% !important;border-collapse:collapse}
    td,th{padding:5px 8px;word-break:break-word;vertical-align:top}
    pre,code{white-space:pre-wrap;word-break:break-all;background:#f6f8fa;padding:2px 6px;border-radius:3px;font-size:12.5px;font-family:'Cascadia Mono','Cascadia Code','Consolas',monospace}
    pre{padding:10px 12px;border:1px solid #e1e4e8}
    blockquote{border-left:3px solid #0078D4;margin:10px 0;padding:6px 14px;color:#3d4248;background:#f4f8fb;border-radius:0 4px 4px 0}
    p{margin:0 0 12px}p:last-child{margin-bottom:0}
    h1,h2,h3,h4,h5,h6{color:#0f172a;margin:16px 0 8px;font-weight:600;line-height:1.3}
    h1{font-size:20px}h2{font-size:17px}h3{font-size:15px}
    hr{border:none;border-top:1px solid #e2e8f0;margin:14px 0}
    ul,ol{padding-left:24px;margin:0 0 12px}
    li{margin-bottom:4px}
    /* Quoted/forwarded blocks (Gmail, Outlook, generic) */
    .gmail_quote,.x_gmail_quote,.gmail_attr,.OutlookMessageHeader{color:#5b6470;border-left:3px solid #cbd5e1;padding:6px 12px;margin-top:14px;font-size:13px;background:#fafbfc}
    div[style*="border-top:solid"]{margin-top:14px;padding-top:10px}
    /* Outlook reply header */
    div.WordSection1{padding-top:0}
    /* Tighter spacing for tables of data */
    table[border]:not([border="0"]) td,table[border]:not([border="0"]) th{border:1px solid #d0d7de}
    /* Common Outlook signature styles */
    div[id^="signature"],div[class*="signature"]{color:#5b6470;font-size:12.5px;border-top:1px solid #e2e8f0;margin-top:12px;padding-top:10px}
    /* Strip Outlook conditional artifacts */
    o\\:p{display:none}
  </style>`;
  const body = rewriteCidImages(raw || "", inlineAttachments);
  if (!body.trim()) return `<!DOCTYPE html><html><head><meta charset="utf-8">${css}</head><body><p style="color:#94a3b8;font-style:italic">No content</p></body></html>`;
  if (body.toLowerCase().includes("<html")) {
    return body.includes("</head>")
      ? body.replace("</head>", css + "</head>")
      : body.replace(/<html[^>]*>/i, `$&<head><meta charset="utf-8">${css}</head>`);
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${css}</head><body>${body}</body></html>`;
}
