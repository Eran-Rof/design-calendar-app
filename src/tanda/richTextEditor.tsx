import React, { useRef, useEffect, useState } from "react";

export const FONT_CHOICES = [
  { label: "Segoe UI", value: "'Segoe UI', system-ui, sans-serif" },
  { label: "Aptos", value: "'Aptos', 'Segoe UI', sans-serif" },
  { label: "Calibri", value: "'Calibri', sans-serif" },
  { label: "Arial", value: "Arial, sans-serif" },
  { label: "Helvetica", value: "Helvetica, sans-serif" },
  { label: "Times New Roman", value: "'Times New Roman', serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Courier New", value: "'Courier New', monospace" },
  { label: "Verdana", value: "Verdana, sans-serif" },
];

/** Wrap raw contenteditable HTML in a complete HTML document with default
 *  styling so the recipient's mail client renders it as rich HTML. */
export function buildEmailHtml(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:'Segoe UI','Aptos','Calibri',sans-serif;font-size:11pt;color:#1f2328;line-height:1.4}
    p{margin:0 0 10px}
    a{color:#0078D4}
    ul,ol{margin:0 0 10px;padding-left:24px}
    blockquote{border-left:2px solid #0078D4;margin:10px 0;padding:4px 12px;color:#475569}
  </style></head><body>${bodyHtml || "&nbsp;"}</body></html>`;
}

/** Small contenteditable rich-text editor — bold, italic, underline, lists,
 *  link, font family, font size, font color. Toolbar buttons reflect the
 *  current selection state. */
export function RichTextEditor({ value, onChange, placeholder, minHeight = 140 }: { value: string; onChange: (html: string) => void; placeholder?: string; minHeight?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const colorRef = useRef<HTMLInputElement | null>(null);
  const [active, setActive] = useState<{ bold: boolean; italic: boolean; underline: boolean; ul: boolean; ol: boolean }>({ bold: false, italic: false, underline: false, ul: false, ol: false });
  const [currentFont, setCurrentFont] = useState<string>("");
  const [currentColor, setCurrentColor] = useState<string>("#3B82F6");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (document.activeElement === el) return;
    if (el.innerHTML !== (value || "")) el.innerHTML = value || "";
  }, [value]);

  const updateActive = () => {
    if (!ref.current) return;
    try {
      setActive({
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
        underline: document.queryCommandState("underline"),
        ul: document.queryCommandState("insertUnorderedList"),
        ol: document.queryCommandState("insertOrderedList"),
      });
      const f = document.queryCommandValue("fontName") || "";
      setCurrentFont(f.replace(/['"]/g, ""));
      const c = document.queryCommandValue("foreColor") || "";
      if (c) setCurrentColor(c);
    } catch {}
  };

  useEffect(() => {
    const update = () => {
      const el = ref.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const node = sel.anchorNode;
      if (!node || !el.contains(node)) return;
      updateActive();
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);

  const exec = (cmd: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    if (ref.current) onChange(ref.current.innerHTML);
    updateActive();
  };

  const btnBase: React.CSSProperties = { width: 26, height: 26, background: "#1E293B", border: "1px solid #334155", borderRadius: 4, color: "#94A3B8", cursor: "pointer", fontSize: 12, fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 };
  const btnActive: React.CSSProperties = { background: "#1D4ED8", border: "1px solid #3B82F6", color: "#ffffff" };
  const sty = (isActive: boolean, extra: React.CSSProperties = {}) => ({ ...btnBase, ...(isActive ? btnActive : {}), ...extra });

  return (
    <div style={{ border: "1px solid #334155", borderRadius: 6, background: "#0F172A", overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 4, padding: 6, borderBottom: "1px solid #334155", background: "#1E293B", flexWrap: "wrap", alignItems: "center" }}>
        <select
          title="Font"
          value={FONT_CHOICES.find(f => currentFont && f.value.toLowerCase().includes(currentFont.toLowerCase()))?.value || ""}
          onChange={e => exec("fontName", e.target.value)}
          style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 4, color: "#94A3B8", fontSize: 11, padding: "3px 4px", height: 26, cursor: "pointer" }}
        >
          <option value="">Font…</option>
          {FONT_CHOICES.map(f => <option key={f.label} value={f.value}>{f.label}</option>)}
        </select>
        <select
          title="Font size"
          onChange={e => { if (e.target.value) exec("fontSize", e.target.value); e.target.value = ""; }}
          style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 4, color: "#94A3B8", fontSize: 11, padding: "3px 4px", height: 26, cursor: "pointer", width: 50 }}
        >
          <option value="">Size</option>
          <option value="1">8</option>
          <option value="2">10</option>
          <option value="3">12</option>
          <option value="4">14</option>
          <option value="5">18</option>
          <option value="6">24</option>
          <option value="7">36</option>
        </select>
        <div style={{ width: 1, background: "#334155", margin: "0 2px" }} />
        <button type="button" title="Bold (Ctrl+B)" style={sty(active.bold, { fontWeight: 700 })} onMouseDown={e => { e.preventDefault(); exec("bold"); }}>B</button>
        <button type="button" title="Italic (Ctrl+I)" style={sty(active.italic, { fontStyle: "italic" })} onMouseDown={e => { e.preventDefault(); exec("italic"); }}>I</button>
        <button type="button" title="Underline (Ctrl+U)" style={sty(active.underline, { textDecoration: "underline" })} onMouseDown={e => { e.preventDefault(); exec("underline"); }}>U</button>
        <div style={{ width: 1, background: "#334155", margin: "0 2px" }} />
        <button
          type="button" title="Font color"
          onMouseDown={e => { e.preventDefault(); ref.current?.focus(); colorRef.current?.click(); }}
          style={{ ...btnBase, position: "relative", flexDirection: "column", gap: 0 }}
        >
          <span style={{ fontSize: 10, lineHeight: 1, color: "#F1F5F9" }}>A</span>
          <span style={{ width: 14, height: 3, background: currentColor || "#3B82F6", borderRadius: 1, marginTop: 1 }} />
        </button>
        <input ref={colorRef} type="color" style={{ position: "absolute", visibility: "hidden", width: 0, height: 0 }}
          onChange={e => exec("foreColor", e.target.value)} />
        <div style={{ width: 1, background: "#334155", margin: "0 2px" }} />
        <button type="button" title="Bulleted list" style={sty(active.ul)} onMouseDown={e => { e.preventDefault(); exec("insertUnorderedList"); }}>•</button>
        <button type="button" title="Numbered list" style={sty(active.ol)} onMouseDown={e => { e.preventDefault(); exec("insertOrderedList"); }}>1.</button>
        <div style={{ width: 1, background: "#334155", margin: "0 2px" }} />
        <button type="button" title="Insert link" style={btnBase} onMouseDown={e => { e.preventDefault(); const url = window.prompt("URL:"); if (url) exec("createLink", url); }}>🔗</button>
        <button type="button" title="Clear formatting" style={btnBase} onMouseDown={e => { e.preventDefault(); exec("removeFormat"); }}>✕</button>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder || ""}
        onInput={e => onChange((e.target as HTMLDivElement).innerHTML)}
        onPaste={e => {
          e.preventDefault();
          const text = e.clipboardData.getData("text/html") || e.clipboardData.getData("text/plain");
          const cleaned = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
          document.execCommand("insertHTML", false, cleaned);
        }}
        style={{
          minHeight,
          padding: "10px 12px",
          color: "#F1F5F9",
          fontSize: 13,
          fontFamily: "'Segoe UI', system-ui, sans-serif",
          lineHeight: 1.55,
          outline: "none",
          overflowY: "auto" as const,
          maxHeight: 300,
        }}
      />
      <style>{`[contenteditable][data-placeholder]:empty::before{content:attr(data-placeholder);color:#475569;pointer-events:none}`}</style>
    </div>
  );
}
