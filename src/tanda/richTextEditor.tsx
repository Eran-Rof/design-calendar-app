import React, { useRef, useEffect, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import FontFamily from "@tiptap/extension-font-family";
import Link from "@tiptap/extension-link";
import { Extension } from "@tiptap/react";

// Custom fontSize extension — Tiptap doesn't include this by default
const FontSize = Extension.create({
  name: "fontSize",
  addGlobalAttributes() {
    return [{
      types: ["textStyle"],
      attributes: {
        fontSize: {
          default: null,
          parseHTML: el => el.style.fontSize || null,
          renderHTML: attrs => attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {},
        },
      },
    }];
  },
});

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

/** Wrap raw contenteditable HTML in a complete HTML document for email sending */
export function buildEmailHtml(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:'Segoe UI','Aptos','Calibri',sans-serif;font-size:11pt;color:#1f2328;line-height:1.4}
    p{margin:0 0 10px}
    a{color:#0078D4}
    ul,ol{margin:0 0 10px;padding-left:24px}
    blockquote{border-left:2px solid #0078D4;margin:10px 0;padding:4px 12px;color:#475569}
  </style></head><body>${bodyHtml || "&nbsp;"}</body></html>`;
}

const FONT_SIZES = [
  { label: "8", value: "8px" },
  { label: "10", value: "10px" },
  { label: "12", value: "12px" },
  { label: "14", value: "14px" },
  { label: "18", value: "18px" },
  { label: "24", value: "24px" },
  { label: "36", value: "36px" },
];

/**
 * Rich text editor powered by Tiptap (ProseMirror-based).
 * Replaces the deprecated document.execCommand approach.
 */
export function RichTextEditor({ value, onChange, placeholder, minHeight = 140 }: { value: string; onChange: (html: string) => void; placeholder?: string; minHeight?: number }) {
  const colorRef = useRef<HTMLInputElement | null>(null);
  const [currentColor, setCurrentColor] = useState("#3B82F6");
  // Force re-render on every editor transaction so toolbar buttons reflect active state
  const [, forceUpdate] = useState(0);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
      }),
      Underline,
      TextStyle,
      Color,
      FontFamily,
      FontSize,
      Link.configure({ openOnClick: false }),
    ],
    content: value || "",
    onUpdate: ({ editor: e }) => {
      onChange(e.getHTML());
    },
    editorProps: {
      attributes: {
        style: `min-height:${minHeight}px;padding:10px 12px;color:#F1F5F9;font-size:13px;font-family:'Segoe UI',system-ui,sans-serif;line-height:1.55;outline:none;overflow-y:auto;max-height:300px`,
        "data-placeholder": placeholder || "",
      },
      handlePaste: (view, event) => {
        // Allow Tiptap to handle paste natively — it sanitizes by default
        return false;
      },
    },
  });

  // Sync upstream value changes (e.g. after Send clears the body, or new compose opens)
  useEffect(() => {
    if (!editor) return;
    const editorHtml = editor.getHTML();
    const normalizedValue = value || "";
    // Always sync when value is empty (compose was reset) or when it differs
    if (normalizedValue === "" && editorHtml !== "<p></p>" && editorHtml !== "") {
      editor.commands.clearContent();
    } else if (normalizedValue && editorHtml !== normalizedValue) {
      editor.commands.setContent(normalizedValue, { emitUpdate: false });
    }
  }, [value, editor]);

  // Re-render toolbar on every selection/transaction so B/I/U/font reflect current state
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const c = editor.getAttributes("textStyle").color;
      if (c) setCurrentColor(c);
      forceUpdate(n => n + 1);
    };
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
    };
  }, [editor]);

  if (!editor) return null;

  const btnBase: React.CSSProperties = { width: 26, height: 26, background: "#1E293B", border: "1px solid #334155", borderRadius: 4, color: "#94A3B8", cursor: "pointer", fontSize: 12, fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 };
  const btnActive: React.CSSProperties = { background: "#1D4ED8", border: "1px solid #3B82F6", color: "#ffffff" };
  const sty = (isActive: boolean, extra: React.CSSProperties = {}) => ({ ...btnBase, ...(isActive ? btnActive : {}), ...extra });

  const textStyleAttrs = editor.getAttributes("textStyle");
  const currentFont = textStyleAttrs.fontFamily || "";
  const currentFontSize = textStyleAttrs.fontSize || "";
  const matchedFont = FONT_CHOICES.find(f => currentFont && f.value.toLowerCase().includes(currentFont.toLowerCase().replace(/['"]/g, "")));
  const matchedSize = FONT_SIZES.find(s => s.value === currentFontSize);

  return (
    <div style={{ border: "1px solid #334155", borderRadius: 6, background: "#0F172A", overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 4, padding: 6, borderBottom: "1px solid #334155", background: "#1E293B", flexWrap: "wrap", alignItems: "center" }}>
        <select
          title="Font"
          value={matchedFont?.value || ""}
          onChange={e => { if (e.target.value) editor.chain().focus().setFontFamily(e.target.value).run(); }}
          style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 4, color: "#94A3B8", fontSize: 11, padding: "3px 6px", height: 26, cursor: "pointer", width: "auto" }}
        >
          <option value="">Font…</option>
          {FONT_CHOICES.map(f => <option key={f.label} value={f.value}>{f.label}</option>)}
        </select>
        <select
          title="Font size"
          value={matchedSize?.value || ""}
          onChange={e => { if (e.target.value) editor.chain().focus().setMark("textStyle", { fontSize: e.target.value }).run(); }}
          style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 4, color: "#94A3B8", fontSize: 11, padding: "3px 4px", height: 26, cursor: "pointer", width: 50 }}
        >
          <option value="">Size</option>
          {FONT_SIZES.map(s => <option key={s.label} value={s.value}>{s.label}</option>)}
        </select>
        <div style={{ width: 1, background: "#334155", margin: "0 2px" }} />
        <button type="button" title="Bold (Ctrl+B)" style={sty(editor.isActive("bold"), { fontWeight: 700 })} onClick={() => editor.chain().focus().toggleBold().run()}>B</button>
        <button type="button" title="Italic (Ctrl+I)" style={sty(editor.isActive("italic"), { fontStyle: "italic" })} onClick={() => editor.chain().focus().toggleItalic().run()}>I</button>
        <button type="button" title="Underline (Ctrl+U)" style={sty(editor.isActive("underline"), { textDecoration: "underline" })} onClick={() => editor.chain().focus().toggleUnderline().run()}>U</button>
        <div style={{ width: 1, background: "#334155", margin: "0 2px" }} />
        <button
          type="button" title="Font color"
          onMouseDown={e => { e.preventDefault(); /* keep editor focus */ }}
          onClick={() => { editor.commands.focus(); setTimeout(() => colorRef.current?.click(), 0); }}
          style={{ ...btnBase, position: "relative", flexDirection: "column", gap: 0 }}
        >
          <span style={{ fontSize: 10, lineHeight: 1, color: "#F1F5F9" }}>A</span>
          <span style={{ width: 14, height: 3, background: currentColor, borderRadius: 1, marginTop: 1 }} />
        </button>
        <input ref={colorRef} type="color" style={{ position: "absolute", visibility: "hidden", width: 0, height: 0 }}
          onChange={e => { setCurrentColor(e.target.value); editor.chain().focus().setColor(e.target.value).run(); }} />
        <div style={{ width: 1, background: "#334155", margin: "0 2px" }} />
        <button type="button" title="Bulleted list" style={sty(editor.isActive("bulletList"))} onClick={() => editor.chain().focus().toggleBulletList().run()}>•</button>
        <button type="button" title="Numbered list" style={sty(editor.isActive("orderedList"))} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1.</button>
        <div style={{ width: 1, background: "#334155", margin: "0 2px" }} />
        <button type="button" title="Insert link" style={btnBase} onClick={() => { const url = window.prompt("URL:"); if (url) editor.chain().focus().setLink({ href: url }).run(); }}>🔗</button>
      </div>
      <EditorContent editor={editor} />
      <style>{`
        .tiptap { outline: none; }
        .tiptap p { margin: 0 0 8px; }
        .tiptap p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: #475569; pointer-events: none; float: left; height: 0; }
        .tiptap ul, .tiptap ol { padding-left: 24px; margin: 0 0 8px; }
        .tiptap a { color: #60A5FA; text-decoration: underline; }
        .tiptap blockquote { border-left: 3px solid #334155; margin: 8px 0; padding: 4px 12px; color: #94A3B8; }
      `}</style>
    </div>
  );
}
