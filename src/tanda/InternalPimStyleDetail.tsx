// src/tanda/InternalPimStyleDetail.tsx
//
// Tangerine P8-8 — PIM per-style detail editor (M42 PIM UI).
//
// Three tabs:
//   - Attributes  — category-specific attribute_definitions with type-aware
//                   inline inputs. Optimistic PATCH per edit.
//   - Description — single locale (en-US for now). Save = PATCH (forces
//                   publish_status='draft'). Separate Publish button calls
//                   POST /description/publish with a confirm modal.
//   - Images      — drag-drop / file-picker upload (multipart, 10MB cap,
//                   image/jpeg|png|webp). Grid of derivatives. Click tile
//                   → modal with full-size print preview + PATCH controls.
//
// Reads /api/internal/pim/styles/:id composite once, then mutates piecemeal.
// Auth: x-user-id header carries the cached Tangerine auth user id (used by
// handlers to stamp updated_by_user_id / published_by_user_id).
//
// Spec: docs/tangerine/P8-data-crm-architecture.md §5 + §6.

import { useEffect, useMemo, useRef, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import { notify, confirmDialog } from "../shared/ui/warn";
import { getCachedAuthUserId } from "../utils/tangerineAuthUser";

type Style = {
  id: string;
  entity_id: string;
  style_code: string;
  style_name: string | null;
  category_id: string | null;
  gender_code: string | null;
  lifecycle_status: string;
  season: string | null;
  design_year: number | null;
  shopify_product_id: string | null;
};

type AttributeDef = {
  id: string;
  label: string;
  value_type: "enum" | "number" | "text" | "boolean" | "date";
  options: { options?: string[] } | null;
  is_required: boolean;
  sort_order: number;
  category_id: string | null;
};

type AttributeRow = {
  id: string | null;
  attribute_key: string;
  value: { value: unknown } | null;
  updated_at: string | null;
  updated_by_user_id: string | null;
  definition: AttributeDef | null;
};

type DescriptionRow = {
  id: string;
  locale: string;
  short_description: string | null;
  long_description: string | null;
  bullet_1: string | null;
  bullet_2: string | null;
  bullet_3: string | null;
  bullet_4: string | null;
  bullet_5: string | null;
  seo_title: string | null;
  seo_description: string | null;
  publish_status: "draft" | "published";
  published_at: string | null;
  published_by_user_id: string | null;
  updated_at: string;
  updated_by_user_id: string | null;
};

type ImageRow = {
  id: string;
  image_kind: "flat" | "lifestyle" | "spec" | "swatch" | "other";
  storage_path: string;
  storage_path_thumb: string | null;
  storage_path_web: string | null;
  storage_path_print: string | null;
  alt_text: string | null;
  sort_order: number;
  is_primary: boolean;
  mime_type: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  created_at: string;
  source?: string | null;
  shopify_image_id?: string | null;
  // Signed URLs for each derivative, attached by the composite GET. The
  // storage_path* fields are bucket-relative and not directly renderable.
  signed_urls?: { thumb: string | null; web: string | null; print: string | null } | null;
};

type Composite = {
  style: Style;
  attributes: AttributeRow[];
  descriptions: DescriptionRow[];
  images: ImageRow[];
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", primaryDim: "#1d4ed8",
  success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
  tangerine: "#fb923c",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnDanger: React.CSSProperties = {
  ...btnSecondary, color: C.danger, borderColor: "#7f1d1d",
};
const btnSuccess: React.CSSProperties = {
  ...btnPrimary, background: C.success,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  colorScheme: "dark",
};
const textareaStyle: React.CSSProperties = {
  ...inputStyle, fontFamily: "inherit", lineHeight: 1.5, resize: "vertical",
};

const TABS = ["Attributes", "Description", "Images"] as const;
type TabKey = typeof TABS[number];

const LOCALE_OPTIONS = ["en-US"]; // only en-US in v1 per spec
const IMAGE_KIND_OPTIONS: ImageRow["image_kind"][] = ["flat", "lifestyle", "spec", "swatch", "other"];

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB per spec
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];

function authHeaders(): Record<string, string> {
  const id = getCachedAuthUserId();
  return id ? { "x-user-id": id } : {};
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      month: "2-digit", day: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

export default function InternalPimStyleDetail({
  styleId,
  onBack,
}: {
  styleId: string;
  onBack: () => void;
}) {
  const [data, setData] = useState<Composite | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("Attributes");

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/pim/styles/${styleId}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setData(await r.json() as Composite);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [styleId]);

  if (loading && !data) {
    return (
      <div style={{ color: C.textMuted, padding: 20 }}>Loading style…</div>
    );
  }

  if (err && !data) {
    return (
      <div style={{ color: C.text }}>
        <button onClick={onBack} style={btnSecondary}>← Back</button>
        <div style={{ background: "#7f1d1d", color: "white", padding: 12, borderRadius: 6, marginTop: 12 }}>
          Failed to load style: {err}
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
        <button onClick={onBack} style={btnSecondary}>← Catalog</button>
        <h2 style={{ margin: 0, fontSize: 20, display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 700, color: C.tangerine }}>
            {data.style.style_code}
          </span>
          <span style={{ fontWeight: 400, color: C.textSub, fontSize: 16 }}>
            {data.style.style_name || ""}
          </span>
        </h2>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 11, color: C.textMuted }}>
          {data.style.season ? `Season ${data.style.season}` : ""}
          {data.style.design_year ? `  ·  ${data.style.design_year}` : ""}
          {data.style.gender_code ? `  ·  ${data.style.gender_code}` : ""}
        </div>
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          {err}
        </div>
      )}

      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.cardBdr}`, marginBottom: 16 }}>
        {TABS.map((t) => {
          const active = t === tab;
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                background: "none",
                color: active ? C.tangerine : C.textSub,
                border: 0,
                borderBottom: active ? `2px solid ${C.tangerine}` : "2px solid transparent",
                padding: "8px 14px",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: active ? 700 : 500,
              }}
            >
              {t}
            </button>
          );
        })}
      </div>

      {tab === "Attributes" && (
        <AttributesTab
          styleId={styleId}
          attributes={data.attributes}
          onChange={(updated) =>
            setData((prev) => prev ? { ...prev, attributes: updated } : prev)
          }
        />
      )}
      {tab === "Description" && (
        <DescriptionTab
          styleId={styleId}
          descriptions={data.descriptions}
          onChange={(updated) =>
            setData((prev) => prev ? { ...prev, descriptions: updated } : prev)
          }
        />
      )}
      {tab === "Images" && (
        <ImagesTab
          styleId={styleId}
          images={data.images}
          shopifyProductId={data.style.shopify_product_id}
          onReload={load}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Attributes tab
// ─────────────────────────────────────────────────────────────────────────────
function AttributesTab({
  styleId,
  attributes,
  onChange,
}: {
  styleId: string;
  attributes: AttributeRow[];
  onChange: (rows: AttributeRow[]) => void;
}) {
  // Sort by definition.sort_order then key. Rows without a def land last.
  const sorted = useMemo(() => {
    return [...attributes].sort((a, b) => {
      const da = a.definition?.sort_order ?? 99999;
      const db = b.definition?.sort_order ?? 99999;
      if (da !== db) return da - db;
      return a.attribute_key.localeCompare(b.attribute_key);
    });
  }, [attributes]);

  return (
    <div>
      {sorted.length === 0 ? (
        <div style={{ padding: 20, color: C.textMuted, fontSize: 13 }}>
          No attribute definitions exist for this style's category yet. Add
          definitions via the Attribute Definitions admin panel (forthcoming
          T9 / admin module) or your category will inherit entity-wide defs
          once any are created.
        </div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Attribute</th>
                <th style={th}>Type</th>
                <th style={th}>Value</th>
                <th style={th}>Last Updated</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => (
                <AttributeRowEditor
                  key={a.attribute_key}
                  styleId={styleId}
                  row={a}
                  onSaved={(updatedRow) => {
                    const next = attributes.map((x) =>
                      x.attribute_key === updatedRow.attribute_key ? updatedRow : x
                    );
                    // Insert if it didn't exist yet (shouldn't happen since defs
                    // drive the list, but keep the merge safe).
                    onChange(next);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13, verticalAlign: "middle",
};

function AttributeRowEditor({
  styleId,
  row,
  onSaved,
}: {
  styleId: string;
  row: AttributeRow;
  onSaved: (updated: AttributeRow) => void;
}) {
  const def = row.definition;
  const currentValue = row.value?.value;
  const [draft, setDraft] = useState<unknown>(currentValue ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "ok" | "err">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    setDraft(currentValue ?? "");
  }, [currentValue]);

  async function patch(newValue: unknown) {
    setStatus("saving");
    setErrMsg(null);
    try {
      const r = await fetch(`/api/internal/pim/styles/${styleId}/attributes`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ attribute_key: row.attribute_key, value: newValue }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const saved = await r.json();
      // Reuse server's updated row but preserve the def we already have.
      onSaved({
        id: saved.id,
        attribute_key: row.attribute_key,
        value: saved.value,
        updated_at: saved.updated_at,
        updated_by_user_id: saved.updated_by_user_id,
        definition: row.definition,
      });
      setStatus("ok");
      setTimeout(() => setStatus("idle"), 1200);
    } catch (e: unknown) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      setStatus("err");
    }
  }

  function commit() {
    // For text/number we send on blur; for enum/boolean/date the change fires inline.
    let v: unknown = draft;
    if (def?.value_type === "number") {
      if (draft === "" || draft == null) v = null;
      else {
        const n = Number(draft);
        if (!Number.isFinite(n)) {
          setStatus("err");
          setErrMsg("Not a valid number");
          return;
        }
        v = n;
      }
    } else if (def?.value_type === "text") {
      v = draft === "" ? null : String(draft);
    }
    void patch(v);
  }

  function renderInput() {
    if (!def) {
      // Orphan attribute — show read-only JSON.
      return <span style={{ color: C.textMuted, fontFamily: "monospace", fontSize: 12 }}>
        {JSON.stringify(currentValue)}
      </span>;
    }
    if (def.value_type === "boolean") {
      const v = draft === true || draft === "true";
      return (
        <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={v}
            onChange={(e) => {
              setDraft(e.target.checked);
              void patch(e.target.checked);
            }}
          />
          {v ? "yes" : "no"}
        </label>
      );
    }
    if (def.value_type === "enum") {
      const opts = def.options?.options || [];
      return (
        <SearchableSelect
          value={draft == null ? "" : String(draft)}
          onChange={(val) => {
            const v = val || null;
            setDraft(v);
            void patch(v);
          }}
          options={[{ value: "", label: "— none —" }, ...opts.map((o) => ({ value: o, label: o }))]}
          inputStyle={inputStyle as React.CSSProperties}
        />
      );
    }
    if (def.value_type === "date") {
      return (
        <input
          type="date"
          value={draft == null ? "" : String(draft)}
          onChange={(e) => {
            const v = e.target.value || null;
            setDraft(v);
            void patch(v);
          }}
          style={inputStyle}
        />
      );
    }
    if (def.value_type === "number") {
      return (
        <input
          type="number"
          step="any"
          value={draft == null ? "" : String(draft)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          style={inputStyle}
        />
      );
    }
    // text (default)
    return (
      <input
        type="text"
        value={draft == null ? "" : String(draft)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        style={inputStyle}
      />
    );
  }

  return (
    <tr>
      <td style={td}>
        <div style={{ fontWeight: 600 }}>
          {def?.label || row.attribute_key}
          {def?.is_required && (
            <span style={{ color: C.danger, marginLeft: 6, fontSize: 11 }}>(required)</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>
          {row.attribute_key}
        </div>
      </td>
      <td style={{ ...td, color: C.textMuted, fontSize: 12 }}>
        {def?.value_type || "—"}
      </td>
      <td style={{ ...td, maxWidth: 300 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {renderInput()}
          {status === "saving" && <span style={{ color: C.textMuted, fontSize: 11 }}>Saving…</span>}
          {status === "ok" && <span style={{ color: C.success, fontSize: 11 }}>✓ saved</span>}
          {status === "err" && (
            <span style={{ color: C.danger, fontSize: 11 }} title={errMsg || ""}>✗ error</span>
          )}
        </div>
        {status === "err" && errMsg && (
          <div style={{ marginTop: 4, fontSize: 11, color: C.danger }}>{errMsg}</div>
        )}
      </td>
      <td style={{ ...td, color: C.textMuted, fontSize: 12 }}>
        {fmtDateTime(row.updated_at)}
      </td>
    </tr>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Description tab
// ─────────────────────────────────────────────────────────────────────────────
function DescriptionTab({
  styleId,
  descriptions,
  onChange,
}: {
  styleId: string;
  descriptions: DescriptionRow[];
  onChange: (rows: DescriptionRow[]) => void;
}) {
  const [locale, setLocale] = useState<string>("en-US");
  const existing = useMemo(
    () => descriptions.find((d) => d.locale === locale) || null,
    [descriptions, locale]
  );

  const [form, setForm] = useState({
    short_description: "",
    long_description: "",
    bullet_1: "", bullet_2: "", bullet_3: "", bullet_4: "", bullet_5: "",
    seo_title: "", seo_description: "",
  });
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  useEffect(() => {
    if (existing) {
      setForm({
        short_description: existing.short_description || "",
        long_description: existing.long_description || "",
        bullet_1: existing.bullet_1 || "",
        bullet_2: existing.bullet_2 || "",
        bullet_3: existing.bullet_3 || "",
        bullet_4: existing.bullet_4 || "",
        bullet_5: existing.bullet_5 || "",
        seo_title: existing.seo_title || "",
        seo_description: existing.seo_description || "",
      });
    } else {
      setForm({
        short_description: "", long_description: "",
        bullet_1: "", bullet_2: "", bullet_3: "", bullet_4: "", bullet_5: "",
        seo_title: "", seo_description: "",
      });
    }
  }, [existing]);

  async function save() {
    setSaving(true); setErr(null); setOkMsg(null);
    try {
      const body = {
        short_description: form.short_description || null,
        long_description: form.long_description || null,
        bullet_1: form.bullet_1 || null,
        bullet_2: form.bullet_2 || null,
        bullet_3: form.bullet_3 || null,
        bullet_4: form.bullet_4 || null,
        bullet_5: form.bullet_5 || null,
        seo_title: form.seo_title || null,
        seo_description: form.seo_description || null,
      };
      const r = await fetch(`/api/internal/pim/styles/${styleId}/description?locale=${encodeURIComponent(locale)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const saved = await r.json() as DescriptionRow;
      // Replace or append in parent state.
      const next = existing
        ? descriptions.map((d) => (d.locale === saved.locale ? saved : d))
        : [...descriptions, saved];
      onChange(next);
      setOkMsg("Saved as draft.");
      setTimeout(() => setOkMsg(null), 2000);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    setPublishing(true); setErr(null); setOkMsg(null);
    try {
      const r = await fetch(`/api/internal/pim/styles/${styleId}/description/publish?locale=${encodeURIComponent(locale)}`, {
        method: "POST",
        headers: { ...authHeaders() },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const saved = await r.json() as DescriptionRow;
      const next = descriptions.map((d) => (d.locale === saved.locale ? saved : d));
      onChange(next);
      setOkMsg(`Published at ${fmtDateTime(saved.published_at)}`);
      setConfirmPublish(false);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setConfirmPublish(false);
    } finally {
      setPublishing(false);
    }
  }

  const isPublished = existing?.publish_status === "published";

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: C.textMuted }}>Locale</label>
        <SearchableSelect
          value={locale || null}
          onChange={(v) => setLocale(v)}
          options={LOCALE_OPTIONS.map((l) => ({ value: l, label: l }))}
          inputStyle={{ ...inputStyle, maxWidth: 140 } as React.CSSProperties}
        />

        <div style={{ flex: 1 }} />

        {existing && (
          <div style={{ fontSize: 12, color: C.textMuted }}>
            Status: <strong style={{ color: isPublished ? C.success : C.warn }}>
              {existing.publish_status}
            </strong>
            {existing.published_at && (
              <span>  ·  published {fmtDateTime(existing.published_at)}</span>
            )}
          </div>
        )}

        <button onClick={() => void save()} disabled={saving} style={btnPrimary}>
          {saving ? "Saving…" : "Save draft"}
        </button>
        <button
          onClick={() => setConfirmPublish(true)}
          disabled={publishing || !existing}
          style={btnSuccess}
          title={!existing ? "Save a draft before publishing" : ""}
        >
          {publishing ? "Publishing…" : "Publish"}
        </button>
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          {err}
        </div>
      )}
      {okMsg && (
        <div style={{ background: "#064e3b", color: "#bbf7d0", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          {okMsg}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 16 }}>
        <FieldBlock label="Short description" hint="≤ 500 chars">
          <textarea
            rows={2}
            value={form.short_description}
            onChange={(e) => setForm({ ...form, short_description: e.target.value })}
            maxLength={500}
            style={textareaStyle}
          />
        </FieldBlock>

        <FieldBlock label="Long description" hint="≤ 20,000 chars">
          <textarea
            rows={8}
            value={form.long_description}
            onChange={(e) => setForm({ ...form, long_description: e.target.value })}
            maxLength={20000}
            style={textareaStyle}
          />
        </FieldBlock>

        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Bullets (up to 5)
          </div>
          {[1, 2, 3, 4, 5].map((i) => {
            const k = `bullet_${i}` as keyof typeof form;
            return (
              <input
                key={i}
                type="text"
                placeholder={`Bullet ${i}`}
                value={form[k]}
                onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                maxLength={500}
                style={{ ...inputStyle, marginBottom: 6 }}
              />
            );
          })}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
          <FieldBlock label="SEO title" hint="≤ 200 chars">
            <input
              type="text"
              value={form.seo_title}
              onChange={(e) => setForm({ ...form, seo_title: e.target.value })}
              maxLength={200}
              style={inputStyle}
            />
          </FieldBlock>
          <FieldBlock label="SEO description" hint="≤ 500 chars">
            <input
              type="text"
              value={form.seo_description}
              onChange={(e) => setForm({ ...form, seo_description: e.target.value })}
              maxLength={500}
              style={inputStyle}
            />
          </FieldBlock>
        </div>
      </div>

      {confirmPublish && (
        <ConfirmPublishModal
          locale={locale}
          onCancel={() => setConfirmPublish(false)}
          onConfirm={() => void publish()}
        />
      )}
    </div>
  );
}

function FieldBlock({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
        {hint && <div style={{ fontSize: 10, color: C.textMuted }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function ConfirmPublishModal({ locale, onCancel, onConfirm }: {
  locale: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card, border: `1px solid ${C.cardBdr}`,
          borderRadius: 10, width: "100%", maxWidth: 440, padding: 24, color: C.text,
        }}
      >
        <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>Publish description?</h3>
        <p style={{ margin: "0 0 16px", color: C.textSub, fontSize: 13, lineHeight: 1.5 }}>
          Publishing flips <code>{locale}</code> from draft to published and stamps
          the current time as <code>published_at</code>. Any future edits will
          re-draft until you publish again.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onCancel} style={btnSecondary}>Cancel</button>
          <button onClick={onConfirm} style={btnSuccess}>Publish</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Images tab
// ─────────────────────────────────────────────────────────────────────────────
function ImagesTab({
  styleId,
  images,
  shopifyProductId,
  onReload,
}: {
  styleId: string;
  images: ImageRow[];
  shopifyProductId: string | null;
  onReload: () => Promise<void>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<Array<{ name: string; pct: number; err?: string }>>([]);
  const [dragOver, setDragOver] = useState(false);
  const [openImage, setOpenImage] = useState<ImageRow | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Shopify link + pull state. `shopifyProductId` is the mirror uuid FK
  // (truthy = linked); the input takes the NUMERIC Shopify product id.
  const isLinked = !!shopifyProductId;
  const [shopId, setShopId] = useState("");
  const [shopBusy, setShopBusy] = useState<"link" | "pull" | null>(null);

  async function linkShopify(unlink = false) {
    setShopBusy("link");
    setErr(null);
    try {
      const r = await fetch(`/api/internal/pim/styles/${styleId}/link-shopify`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ shopify_product_id: unlink ? null : (shopId.trim() || null) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      notify(j.linked ? `Linked to Shopify product ${j.shopify_numeric_id}${j.title ? ` (${j.title})` : ""}` : "Unlinked from Shopify", "success");
      if (j.linked) setShopId("");
      await onReload();
    } catch (e: unknown) {
      setErr(`Link failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setShopBusy(null);
    }
  }

  async function pullShopify() {
    setShopBusy("pull");
    setErr(null);
    try {
      const r = await fetch(`/api/internal/pim/styles/${styleId}/pull-shopify-images`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const parts = [`${j.pulled} pulled`];
      if (j.skipped) parts.push(`${j.skipped} already present`);
      if (j.failed) parts.push(`${j.failed} failed`);
      notify(`Shopify images: ${parts.join(", ")}`, j.failed ? "error" : "success");
      if (Array.isArray(j.errors) && j.errors.length) setErr(j.errors.join("\n"));
      await onReload();
    } catch (e: unknown) {
      setErr(`Pull failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setShopBusy(null);
    }
  }

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;

    // Pre-flight: bounce anything that's the wrong type / too big.
    const rejects: string[] = [];
    const accepts: File[] = [];
    for (const f of list) {
      if (!ALLOWED_MIME.includes(f.type)) {
        rejects.push(`${f.name}: unsupported type (${f.type || "unknown"})`);
        continue;
      }
      if (f.size > MAX_IMAGE_BYTES) {
        rejects.push(`${f.name}: ${(f.size / 1024 / 1024).toFixed(1)} MB exceeds 10 MB cap`);
        continue;
      }
      accepts.push(f);
    }
    if (rejects.length > 0) setErr(rejects.join("\n"));

    if (accepts.length === 0) return;

    setUploading((prev) => [
      ...prev,
      ...accepts.map((f) => ({ name: f.name, pct: 0 })),
    ]);

    // Upload sequentially so we get clean progress per file and don't stampede
    // Sharp on the server side.
    for (const f of accepts) {
      try {
        await uploadOne(f);
        setUploading((prev) => prev.filter((u) => u.name !== f.name));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setUploading((prev) => prev.map((u) => u.name === f.name ? { ...u, err: msg } : u));
      }
    }
    await onReload();
  }

  function uploadOne(file: File): Promise<void> {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append("file", file, file.name);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/internal/pim/styles/${styleId}/images`);
      const id = getCachedAuthUserId();
      if (id) xhr.setRequestHeader("x-user-id", id);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          setUploading((prev) => prev.map((u) => u.name === file.name ? { ...u, pct } : u));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else {
          let msg = `HTTP ${xhr.status}`;
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* ignore */ }
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error("Network error"));
      xhr.send(fd);
    });
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void handleFiles(e.dataTransfer.files);
    }
  }

  async function patchImage(id: string, patch: Partial<ImageRow>) {
    const r = await fetch(`/api/internal/pim/images/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    await onReload();
  }

  async function deleteImage(id: string) {
    if (!(await confirmDialog("Delete this image? It will be removed from the style; storage cleanup is async."))) return;
    try {
      const r = await fetch(`/api/internal/pim/images/${id}`, {
        method: "DELETE",
        headers: { ...authHeaders() },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await onReload();
      setOpenImage(null);
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div>
      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, whiteSpace: "pre-wrap" }}>
          {err}
          <button
            onClick={() => setErr(null)}
            style={{ marginLeft: 12, background: "transparent", color: "white", border: "1px solid white", padding: "2px 8px", borderRadius: 4, cursor: "pointer", fontSize: 11 }}
          >
            dismiss
          </button>
        </div>
      )}

      {/* Shopify: link a product, then re-host its images into this style. */}
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 12, marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.textSub, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
          Shopify product images
          {isLinked && (
            <span style={{ background: C.tangerine, color: "#000", borderRadius: 4, padding: "1px 6px", fontSize: 10, fontWeight: 700 }}>
              ✓ LINKED
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <input
            type="text"
            value={shopId}
            onChange={(e) => setShopId(e.target.value)}
            placeholder={isLinked ? "Enter a new Shopify product ID to re-link" : "Shopify product ID (digits)"}
            style={{ ...inputStyle, width: 240 }}
          />
          <button
            onClick={() => void linkShopify(false)}
            disabled={shopBusy != null || shopId.trim() === ""}
            style={{ ...btnSecondary, opacity: (shopBusy != null || shopId.trim() === "") ? 0.6 : 1 }}
          >
            {shopBusy === "link" ? "Saving…" : isLinked ? "Re-link" : "Link product"}
          </button>
          {isLinked && (
            <button
              onClick={() => void linkShopify(true)}
              disabled={shopBusy != null}
              style={{ ...btnSecondary, opacity: shopBusy != null ? 0.6 : 1 }}
            >
              Unlink
            </button>
          )}
          <button
            onClick={() => void pullShopify()}
            disabled={shopBusy != null || !isLinked}
            title={!isLinked ? "Link a Shopify product first" : "Re-host this product's Shopify images"}
            style={{ ...btnPrimary, opacity: (shopBusy != null || !isLinked) ? 0.6 : 1 }}
          >
            {shopBusy === "pull" ? "Pulling…" : "Pull from Shopify"}
          </button>
        </div>
        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>
          Images are copied into your own storage, so they stay even if the product changes on Shopify.
        </div>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        style={{
          background: dragOver ? "#0b1220" : C.card,
          border: `2px dashed ${dragOver ? C.tangerine : C.cardBdr}`,
          borderRadius: 10,
          padding: 24,
          textAlign: "center",
          marginBottom: 16,
          color: C.textSub,
          transition: "border 0.15s, background 0.15s",
        }}
      >
        <div style={{ fontSize: 14, marginBottom: 8 }}>
          Drop images here, or
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{ ...btnPrimary, marginLeft: 8 }}
          >
            Choose files
          </button>
        </div>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          JPEG / PNG / WebP. Up to 10 MB each. Server resizes to thumb / web / print.
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          onChange={(e) => e.target.files && void handleFiles(e.target.files)}
          style={{ display: "none" }}
        />
      </div>

      {uploading.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {uploading.map((u) => (
            <div key={u.name} style={{
              background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 6,
              padding: "6px 12px", marginBottom: 6, fontSize: 12, color: C.textSub,
              display: "flex", alignItems: "center", gap: 12,
            }}>
              <span style={{ flex: 1, fontFamily: "monospace" }}>{u.name}</span>
              {u.err ? (
                <span style={{ color: C.danger }}>✗ {u.err}</span>
              ) : u.pct < 100 ? (
                <span>{u.pct}% uploaded</span>
              ) : (
                <span style={{ color: C.warn }}>⟳ processing…</span>
              )}
              <div style={{
                width: 160, height: 6, background: "#0b1220", borderRadius: 3, overflow: "hidden",
              }}>
                <div style={{
                  width: `${u.pct}%`, height: "100%",
                  background: u.err ? C.danger : u.pct < 100 ? C.primary : C.warn,
                }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {images.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13 }}>
          No images yet. Upload via the drop zone above.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 12 }}>
          {images.map((img) => (
            <ImageTile
              key={img.id}
              img={img}
              onClick={() => setOpenImage(img)}
            />
          ))}
        </div>
      )}

      {openImage && (
        <ImageDetailModal
          img={openImage}
          allImages={images}
          onClose={() => setOpenImage(null)}
          onPatch={async (patch) => {
            await patchImage(openImage.id, patch);
            // Reload happens inside patchImage; we need to refresh the modal too.
            const updated = images.find((i) => i.id === openImage.id);
            if (updated) setOpenImage(updated);
          }}
          onDelete={() => void deleteImage(openImage.id)}
        />
      )}
    </div>
  );
}

function ImageTile({ img, onClick }: { img: ImageRow; onClick: () => void }) {
  const thumb = img.signed_urls?.web || img.signed_urls?.thumb || img.signed_urls?.print || null;
  return (
    <div
      onClick={onClick}
      style={{
        background: C.card, border: `1px solid ${img.is_primary ? C.tangerine : C.cardBdr}`,
        borderRadius: 8, overflow: "hidden", cursor: "pointer",
        position: "relative", transition: "border 0.15s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = C.primary)}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = img.is_primary ? C.tangerine : C.cardBdr)}
    >
      <div style={{ aspectRatio: "1 / 1", background: "#0b1220", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {thumb ? (
          <img
            src={thumb}
            alt={img.alt_text || ""}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
          />
        ) : (
          <span style={{ color: C.textMuted, fontSize: 12 }}>No image</span>
        )}
        {img.is_primary && (
          <div style={{
            position: "absolute", top: 6, left: 6,
            background: C.tangerine, color: "#000", borderRadius: 4,
            padding: "1px 6px", fontSize: 10, fontWeight: 700,
          }}>
            ★ PRIMARY
          </div>
        )}
        <div style={{
          position: "absolute", top: 6, right: 6,
          background: "rgba(0,0,0,0.6)", color: C.textSub, borderRadius: 4,
          padding: "1px 6px", fontSize: 10, fontWeight: 600, textTransform: "uppercase",
        }}>
          {img.image_kind}
        </div>
      </div>
      {img.alt_text && (
        <div style={{
          padding: "4px 8px", fontSize: 11, color: C.textSub,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {img.alt_text}
        </div>
      )}
    </div>
  );
}

function ImageDetailModal({
  img,
  allImages,
  onClose,
  onPatch,
  onDelete,
}: {
  img: ImageRow;
  allImages: ImageRow[];
  onClose: () => void;
  onPatch: (patch: Partial<ImageRow>) => Promise<void>;
  onDelete: () => void;
}) {
  const [alt, setAlt] = useState(img.alt_text || "");
  const [kind, setKind] = useState<ImageRow["image_kind"]>(img.image_kind);
  const [saving, setSaving] = useState<string | null>(null);

  const printSrc = img.signed_urls?.print || img.signed_urls?.web || img.signed_urls?.thumb || null;

  // sort_order arrows: move to a relative neighbour.
  const sorted = useMemo(() => [...allImages].sort((a, b) => a.sort_order - b.sort_order), [allImages]);
  const idx = sorted.findIndex((i) => i.id === img.id);
  const canMoveUp = idx > 0;
  const canMoveDown = idx >= 0 && idx < sorted.length - 1;

  async function withSave(label: string, fn: () => Promise<void>) {
    setSaving(label);
    try { await fn(); }
    catch (e: unknown) { notify(`${label} failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
    finally { setSaving(null); }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
        zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card, border: `1px solid ${C.cardBdr}`,
          borderRadius: 10, width: "100%", maxWidth: 1000, maxHeight: "90vh",
          overflow: "auto", padding: 20, color: C.text,
          display: "grid", gridTemplateColumns: "1fr 320px", gap: 20,
        }}
      >
        <div style={{ background: "#0b1220", borderRadius: 6, padding: 12, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 400 }}>
          {printSrc ? (
            <img
              src={printSrc}
              alt={img.alt_text || ""}
              style={{ maxWidth: "100%", maxHeight: "70vh", objectFit: "contain" }}
            />
          ) : (
            <span style={{ color: C.textMuted }}>No preview available</span>
          )}
        </div>

        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>Image details</h3>
            <button onClick={onClose} style={{ ...btnSecondary, padding: "4px 8px" }}>✕</button>
          </div>

          <FieldBlock label="Alt text">
            <input
              type="text"
              value={alt}
              onChange={(e) => setAlt(e.target.value)}
              onBlur={() => alt !== (img.alt_text || "") && void withSave("Alt text", () => onPatch({ alt_text: alt || null }))}
              style={inputStyle}
              placeholder="For accessibility + SEO"
            />
          </FieldBlock>

          <FieldBlock label="Image kind">
            <SearchableSelect
              value={kind}
              onChange={(val) => {
                const v = val as ImageRow["image_kind"];
                setKind(v);
                void withSave("Image kind", () => onPatch({ image_kind: v }));
              }}
              options={IMAGE_KIND_OPTIONS.map((k) => ({ value: k, label: k }))}
              inputStyle={inputStyle as React.CSSProperties}
            />
          </FieldBlock>

          <FieldBlock label="Primary">
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={img.is_primary}
                onChange={(e) => void withSave("Primary toggle", () => onPatch({ is_primary: e.target.checked }))}
              />
              ★ Use as primary image (shown in catalog list)
            </label>
          </FieldBlock>

          <FieldBlock label="Sort order">
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                disabled={!canMoveUp || saving != null}
                onClick={() => {
                  const target = sorted[idx - 1];
                  if (!target) return;
                  void withSave("Reorder", async () => {
                    await onPatch({ sort_order: target.sort_order });
                  });
                }}
                style={btnSecondary}
              >
                ↑ Up
              </button>
              <button
                disabled={!canMoveDown || saving != null}
                onClick={() => {
                  const target = sorted[idx + 1];
                  if (!target) return;
                  void withSave("Reorder", async () => {
                    await onPatch({ sort_order: target.sort_order });
                  });
                }}
                style={btnSecondary}
              >
                ↓ Down
              </button>
              <span style={{ marginLeft: 8, color: C.textMuted, fontSize: 12 }}>
                pos {idx + 1} of {sorted.length}
              </span>
            </div>
          </FieldBlock>

          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 16, lineHeight: 1.5 }}>
            <div>Uploaded {fmtDateTime(img.created_at)}</div>
            {img.width != null && img.height != null && (
              <div>{img.width} × {img.height} px · {img.mime_type || "?"}</div>
            )}
            {img.bytes != null && (
              <div>{(img.bytes / 1024).toFixed(1)} KB original</div>
            )}
          </div>

          {saving && (
            <div style={{ marginTop: 12, fontSize: 12, color: C.warn }}>
              Saving {saving}…
            </div>
          )}

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.cardBdr}` }}>
            <button onClick={onDelete} style={btnDanger}>
              Delete image
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
