// Injects clean, readable CSS into raw email HTML for display in iframes
export function styledEmailHtml(raw: string): string {
  const css = `<style>
    *{box-sizing:border-box}
    body{font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;line-height:1.65;color:#1e293b;background:#fff;padding:20px 24px;margin:0;word-wrap:break-word;max-width:100%;overflow-x:hidden}
    img{max-width:100%;height:auto;border-radius:4px}
    a{color:#0078D4;text-decoration:underline}
    a:hover{color:#106EBE}
    table{max-width:100% !important;width:auto !important;border-collapse:collapse}
    td,th{padding:6px 8px;word-break:break-word;vertical-align:top}
    pre,code{white-space:pre-wrap;word-break:break-all;background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:13px;font-family:'Cascadia Code',Consolas,monospace}
    blockquote{border-left:3px solid #0078D4;margin:10px 0;padding:4px 14px;color:#475569;background:#f8fafc;border-radius:0 4px 4px 0}
    p{margin:0 0 10px}p:last-child{margin-bottom:0}
    h1,h2,h3,h4,h5,h6{color:#0f172a;margin:14px 0 6px;font-weight:600;line-height:1.3}
    h1{font-size:20px}h2{font-size:17px}h3{font-size:15px}
    hr{border:none;border-top:1px solid #e2e8f0;margin:14px 0}
    ul,ol{padding-left:22px;margin:0 0 10px}
    li{margin-bottom:4px}
    .gmail_quote,.x_gmail_quote,.gmail_attr{color:#64748b;border-left:3px solid #cbd5e1;padding-left:12px;margin-top:12px;font-size:13px}
    div[style*="border-left"]{font-size:13px;color:#64748b}
    span[style*="font-size:small"],span[style*="font-size: small"]{font-size:13px !important;color:#64748b}
  </style>`;
  if (!raw || !raw.trim()) return `<!DOCTYPE html><html><head><meta charset="utf-8">${css}</head><body><p style="color:#94a3b8;font-style:italic">No content</p></body></html>`;
  if (raw.toLowerCase().includes("<html")) {
    return raw.includes("</head>")
      ? raw.replace("</head>", css + "</head>")
      : raw.replace(/<html[^>]*>/i, `$&<head><meta charset="utf-8">${css}</head>`);
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${css}</head><body>${raw}</body></html>`;
}
