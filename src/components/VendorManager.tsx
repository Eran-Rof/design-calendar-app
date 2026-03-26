import React, { useState, useRef, useEffect } from "react";
import { TH } from "../utils/theme";
import { appConfirm } from "../utils/theme";
import { S } from "../utils/styles";
import { uid, addDaysForPhase, diffDaysForPhase, diffDays, toDateStr, addDays } from "../utils/dates";
import { CATEGORIES, DEFAULT_TASK_TEMPLATES } from "../utils/constants";
import { LeadTimeCell } from "./DateInput";

const DEFAULT_WIP_TEMPLATES_DC = [
  { id: "wip_labdip",    phase: "Lab Dip / Strike Off",      category: "Pre-Production", daysBeforeDDP: 120 },
  { id: "wip_trims",     phase: "Trims",                     category: "Pre-Production", daysBeforeDDP: 110 },
  { id: "wip_rawgoods",  phase: "Raw Goods Available",       category: "Fabric T&A",     daysBeforeDDP: 100 },
  { id: "wip_fabprint",  phase: "Fabric at Printing Mill",   category: "Fabric T&A",     daysBeforeDDP: 90  },
  { id: "wip_fabfg",     phase: "Fabric Finished Goods",     category: "Fabric T&A",     daysBeforeDDP: 80  },
  { id: "wip_fabfact",   phase: "Fabric at Factory",         category: "Fabric T&A",     daysBeforeDDP: 70  },
  { id: "wip_fabcut",    phase: "Fabric at Cutting Line",    category: "Fabric T&A",     daysBeforeDDP: 60  },
  { id: "wip_fitsample", phase: "Fit Sample",                category: "Samples",        daysBeforeDDP: 90  },
  { id: "wip_ppsample",  phase: "PP Sample",                 category: "Samples",        daysBeforeDDP: 75  },
  { id: "wip_ppapproval",phase: "PP Approval",               category: "Samples",        daysBeforeDDP: 65  },
  { id: "wip_sizeset",   phase: "Size Set",                  category: "Samples",        daysBeforeDDP: 55  },
  { id: "wip_fabready",  phase: "Fabric Ready",              category: "Production",     daysBeforeDDP: 50  },
  { id: "wip_prodstart", phase: "Prod Start",                category: "Production",     daysBeforeDDP: 42  },
  { id: "wip_packstart", phase: "Packing Start",             category: "Production",     daysBeforeDDP: 28  },
  { id: "wip_prodend",   phase: "Prod End",                  category: "Production",     daysBeforeDDP: 21  },
  { id: "wip_topsample", phase: "Top Sample",                category: "Transit",        daysBeforeDDP: 18  },
  { id: "wip_exfactory", phase: "Ex Factory",                category: "Transit",        daysBeforeDDP: 14  },
  { id: "wip_packdocs",  phase: "Packing List / Docs Rec'd", category: "Transit",        daysBeforeDDP: 7   },
  { id: "wip_inhouse",   phase: "In House / DDP",            category: "Transit",        daysBeforeDDP: 0   },
];

function VendorForm({ vendor, onSave, onCancel, taskTemplates, isEdit = false }) {
  const templates = (taskTemplates && taskTemplates.length > 0) ? taskTemplates : DEFAULT_TASK_TEMPLATES;
  const [f, setF] = useState(
    vendor || {
      id: uid(),
      name: "",
      country: "",
      transitDays: 21,
      categories: [],
      contact: "",
      email: "",
      moq: 0,
      leadOverrides: {},
      wipLeadOverrides: {},
    }
  );
  const [leadTab, setLeadTab] = useState("design");
  const [wipTpls, setWipTpls] = useState([]);
  // Load wip_templates from app_data on mount
  useEffect(() => {
    (async () => {
      try {
        const SB_URL = "https://qcvqvxxoperiurauoxmp.supabase.co";
        const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjdnF2eHhvcGVyaXVyYXVveG1wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2ODU4MjksImV4cCI6MjA4OTI2MTgyOX0.YoBmIdlqqPYt9roTsDPGSBegNnoupCYSsnyCHMo24Zw";
        const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.wip_templates&select=value`, {
          headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` },
        });
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length > 0 && rows[0].value) {
          const parsed = JSON.parse(rows[0].value);
          if (Array.isArray(parsed) && parsed.length > 0) { setWipTpls(parsed); return; }
        }
      } catch {}
      setWipTpls(DEFAULT_WIP_TEMPLATES_DC);
    })();
  }, []);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setOverride = (phase, val) =>
    setF((x) => ({ ...x, leadOverrides: { ...(x.leadOverrides || {}), [phase]: parseInt(val) || 0 } }));
  const clearOverride = (phase) =>
    setF((x) => {
      const next = { ...(x.leadOverrides || {}) };
      delete next[phase];
      return { ...x, leadOverrides: next };
    });
  const setWipOverride = (phase, val) =>
    setF((x) => ({ ...x, wipLeadOverrides: { ...(x.wipLeadOverrides || {}), [phase]: parseInt(val) || 0 } }));
  const clearWipOverride = (phase) =>
    setF((x) => {
      const next = { ...(x.wipLeadOverrides || {}) };
      delete next[phase];
      return { ...x, wipLeadOverrides: next };
    });
  const toggleCat = (c) =>
    setF((x) => ({
      ...x,
      categories: x.categories.includes(c)
        ? x.categories.filter((x) => x !== c)
        : [...x.categories, c],
    }));
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div>
          <label style={S.lbl}>Vendor Name</label>
          {isEdit ? (
            <div style={{ ...S.inp, marginBottom: 0, background: TH.surfaceHi, color: TH.textSub, cursor: "default", display: "flex", alignItems: "center" }}>
              {f.name}
            </div>
          ) : (
            <input
              style={{ ...S.inp, marginBottom: 0 }}
              value={f.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Factory name"
            />
          )}
        </div>
        <div>
          <label style={S.lbl}>Country</label>
          <input
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.country}
            onChange={(e) => set("country", e.target.value)}
            placeholder="e.g. China"
          />
        </div>
      </div>
      <div style={{ height: 14 }} />
      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}
      >
        <div>
          <label style={S.lbl}>Transit Days</label>
          <input
            type="number"
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.transitDays}
            onChange={(e) => set("transitDays", parseInt(e.target.value) || 0)}
          />
        </div>
        <div>
          <label style={S.lbl}>MOQ</label>
          <input
            type="number"
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.moq}
            onChange={(e) => set("moq", parseInt(e.target.value) || 0)}
          />
        </div>
        <div>
          <label style={S.lbl}>Contact Email</label>
          <input
            style={{ ...S.inp, marginBottom: 0 }}
            value={f.email}
            onChange={(e) => set("email", e.target.value)}
          />
        </div>
      </div>
      <div style={{ height: 14 }} />
      <label style={S.lbl}>Contact Name</label>
      <input
        style={S.inp}
        value={f.contact}
        onChange={(e) => set("contact", e.target.value)}
      />
      <label style={S.lbl}>Category Specialties</label>
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 16 }}
      >
        {CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => toggleCat(c)}
            style={{
              padding: "4px 12px",
              borderRadius: 16,
              border: `1px solid ${
                f.categories.includes(c) ? TH.primary : TH.border
              }`,
              background: f.categories.includes(c)
                ? TH.primary + "15"
                : "transparent",
              color: f.categories.includes(c) ? TH.primary : TH.textMuted,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 12,
            }}
          >
            {c}
          </button>
        ))}
      </div>
      {/* Lead Times Tab Bar */}
      <div style={{ display: "flex", gap: 0, marginBottom: 14, borderBottom: `2px solid ${TH.border}` }}>
        <button onClick={() => setLeadTab("design")} style={{ padding: "8px 16px", border: "none", borderBottom: leadTab === "design" ? `2px solid ${TH.primary}` : "2px solid transparent", marginBottom: -2, background: "none", color: leadTab === "design" ? TH.primary : TH.textMuted, fontWeight: leadTab === "design" ? 700 : 400, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>
          Design Lead Times
        </button>
        <button onClick={() => setLeadTab("production")} style={{ padding: "8px 16px", border: "none", borderBottom: leadTab === "production" ? `2px solid ${TH.primary}` : "2px solid transparent", marginBottom: -2, background: "none", color: leadTab === "production" ? TH.primary : TH.textMuted, fontWeight: leadTab === "production" ? 700 : 400, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>
          Production Lead Times
        </button>
      </div>
      {leadTab === "design" && (<>
      <div style={{ fontSize: 12, color: TH.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
        Sorted earliest→latest. Edit either column — they stay in sync. Tab out to re-sort. <span style={{ color: TH.primary }}>•custom</span> means this vendor differs from the template default.
        <br /><span style={{ color: TH.textSub2 }}>All values are <strong>business days</strong> — Mon–Thu = 1 day, Fri = 0.5 day, weekends &amp; holidays = 0.</span>
      </div>
      {(() => {
        const overrides = f.leadOverrides || {};
        const sortedTpls = [...templates]
          .filter(tpl => tpl.phase !== "DDP" && tpl.phase !== "Ship Date")
          .sort((a, b) => {
            const av = overrides[a.phase] ?? a.daysBeforeDDP ?? 0;
            const bv = overrides[b.phase] ?? b.daysBeforeDDP ?? 0;
            return bv - av; // descending = longest (earliest) first
          });
        return (
          <div style={{ border: `1px solid ${TH.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 20 }}>
            {/* Header */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px 120px 36px", background: TH.surfaceHi, padding: "7px 14px", fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: `1px solid ${TH.border}` }}>
              <span>Phase</span>
              <span style={{ textAlign: "center" }}>Bus. Days Before DDP</span>
              <span style={{ textAlign: "center" }}>From Prev</span>
              <span />
            </div>
            {(() => {
              // Reference DDP 400 days from now — used to compute actual date gaps
              const refDDP = addDays(new Date().toISOString().split("T")[0], 400);
              return sortedTpls.map((tpl, idx) => {
                const effectiveDays = overrides[tpl.phase] ?? tpl.daysBeforeDDP ?? 0;
                const prevTpl = idx > 0 ? sortedTpls[idx - 1] : null;
                const prevEffective = prevTpl ? (overrides[prevTpl.phase] ?? prevTpl.daysBeforeDDP ?? 0) : null;
                const curDate = addDaysForPhase(refDDP, -effectiveDays, tpl.phase);
                const prevDate = prevTpl ? addDaysForPhase(refDDP, -prevEffective!, prevTpl.phase) : null;
                const fromPrev = prevDate ? diffDaysForPhase(curDate, prevDate, tpl.phase) : null;
                const hasOverride = overrides[tpl.phase] !== undefined;
                return (
                  <div key={tpl.phase} style={{ display: "grid", gridTemplateColumns: "1fr 120px 120px 36px", padding: "8px 14px", borderBottom: idx < sortedTpls.length - 1 ? `1px solid ${TH.border}` : "none", alignItems: "center", background: idx % 2 === 0 ? "#fff" : TH.surfaceHi }}>
                    <div style={{ fontSize: 13, color: TH.text, display: "flex", alignItems: "center", gap: 6 }}>
                      {tpl.phase}
                      {hasOverride
                        ? <span style={{ fontSize: 10, color: TH.primary, fontWeight: 700, background: TH.primary + "15", padding: "1px 6px", borderRadius: 8 }}>custom</span>
                        : <span style={{ fontSize: 10, color: TH.border }}>tpl</span>
                      }
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <LeadTimeCell
                        value={effectiveDays}
                        onCommit={n => setOverride(tpl.phase, n)}
                      />
                    </div>
                    <div style={{ textAlign: "center" }}>
                      {fromPrev !== null && prevDate ? (
                        <LeadTimeCell
                          value={fromPrev}
                          onCommit={n => {
                            const newDate = addDaysForPhase(prevDate, n, tpl.phase);
                            const newDays = Math.round(diffDaysForPhase(refDDP, newDate, tpl.phase));
                            if (newDays >= 0) setOverride(tpl.phase, newDays);
                          }}
                        />
                      ) : (
                        <span style={{ fontSize: 12, color: TH.textMuted }}>—</span>
                      )}
                    </div>
                    <div style={{ textAlign: "center" }}>
                      {hasOverride && (
                        <button onClick={() => clearOverride(tpl.phase)} title="Reset to template default" style={{ padding: "3px 6px", borderRadius: 5, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 11, lineHeight: 1 }}>✕</button>
                      )}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        );
      })()}
      </>)}
      {leadTab === "production" && (<>
      <div style={{ fontSize: 12, color: TH.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
        Production milestone lead times for this vendor. <span style={{ color: TH.primary }}>•custom</span> means this vendor differs from the production template default.
      </div>
      {(() => {
        const overrides = f.wipLeadOverrides || {};
        const prodTpls = wipTpls.length > 0 ? wipTpls : DEFAULT_WIP_TEMPLATES_DC;
        const sortedProd = [...prodTpls].sort((a, b) => (b.daysBeforeDDP ?? 0) - (a.daysBeforeDDP ?? 0));
        return (
          <div style={{ border: `1px solid ${TH.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 20 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 140px 120px 36px", background: TH.surfaceHi, padding: "7px 14px", fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: `1px solid ${TH.border}` }}>
              <span>Phase</span>
              <span style={{ textAlign: "center" }}>Category</span>
              <span style={{ textAlign: "center" }}>Days Before DDP</span>
              <span />
            </div>
            {sortedProd.map((tpl, idx) => {
              const effectiveDays = overrides[tpl.phase] ?? tpl.daysBeforeDDP ?? 0;
              const hasOverride = overrides[tpl.phase] !== undefined;
              return (
                <div key={tpl.phase} style={{ display: "grid", gridTemplateColumns: "1fr 140px 120px 36px", padding: "8px 14px", borderBottom: idx < sortedProd.length - 1 ? `1px solid ${TH.border}` : "none", alignItems: "center", background: idx % 2 === 0 ? "#fff" : TH.surfaceHi }}>
                  <div style={{ fontSize: 13, color: TH.text, display: "flex", alignItems: "center", gap: 6 }}>
                    {tpl.phase}
                    {hasOverride
                      ? <span style={{ fontSize: 10, color: TH.primary, fontWeight: 700, background: TH.primary + "15", padding: "1px 6px", borderRadius: 8 }}>custom</span>
                      : <span style={{ fontSize: 10, color: TH.border }}>tpl</span>
                    }
                  </div>
                  <div style={{ textAlign: "center", fontSize: 11, color: TH.textMuted }}>{tpl.category}</div>
                  <div style={{ textAlign: "center" }}>
                    <LeadTimeCell
                      value={effectiveDays}
                      onCommit={n => setWipOverride(tpl.phase, n)}
                    />
                  </div>
                  <div style={{ textAlign: "center" }}>
                    {hasOverride && (
                      <button onClick={() => clearWipOverride(tpl.phase)} title="Reset to template default" style={{ padding: "3px 6px", borderRadius: 5, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 11, lineHeight: 1 }}>✕</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}
      </>)}
      <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
        <button
          onClick={onCancel}
          style={{
            padding: "9px 18px",
            borderRadius: 8,
            border: `1px solid ${TH.border}`,
            background: "none",
            color: TH.textMuted,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Cancel
        </button>
        <button
          disabled={!f.name}
          onClick={() => onSave(f)}
          style={{ ...S.btn, opacity: f.name ? 1 : 0.4 }}
        >
          Save Vendor
        </button>
      </div>
    </div>
  );
}

function VendorManager({ vendors, setVendors, isAdmin = false, taskTemplates }) {
  const fileRef = useRef();
  const [msg, setMsg] = useState(null);
  if (!isAdmin) return (
    <div style={{ padding: "20px", textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
      <div style={{ fontSize: 24, marginBottom: 8 }}>🔒</div>
      <div style={{ fontWeight: 600, color: TH.text, marginBottom: 4 }}>Admin Only</div>
      <div>Only admins can manage this section.</div>
    </div>
  );
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState("");

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = window.XLSX.read(ev.target.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = window.XLSX.utils.sheet_to_json(ws, {
          header: 1,
          defval: "",
        });
        const hi = rows.findIndex((r) =>
          r.some((c) => String(c).trim() === "Vendor Name")
        );
        if (hi < 0) {
          setMsg({ t: "err", m: "Can't find 'Vendor Name' header." });
          return;
        }
        const hdrs = rows[hi].map((h) => String(h).trim());
        const col = (n) => hdrs.indexOf(n);
        const parsed = [];
        for (let i = hi + 1; i < rows.length; i++) {
          const r = rows[i],
            name = String(r[col("Vendor Name")] || "").trim();
          if (!name) continue;
          const exist = vendors.find(
            (v) => v.name.toLowerCase() === name.toLowerCase()
          );
          parsed.push({
            id: exist ? exist.id : uid(),
            name,
            country: String(r[col("Country of Origin")] || "").trim(),
            transitDays: parseInt(r[col("Transit Days (to US)")]) || 21,
            categories: String(r[col("Category Specialties")] || "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            contact: String(r[col("Contact Name")] || "").trim(),
            email: String(r[col("Contact Email")] || "").trim(),
            moq: parseInt(r[col("MOQ")]) || 0,
            _up: !!exist,
            lead: {
              Concept: parseFloat(r[col("Concept (days)")]) || 168,
              Design: parseFloat(r[col("Design (days)")]) || 154,
              "Tech Pack": parseFloat(r[col("Tech Pack (days)")]) || 140,
              Costing: parseFloat(r[col("Costing (days)")]) || 126,
              Sampling: parseFloat(r[col("Sampling (days)")]) || 112,
              Revision: parseFloat(r[col("Revision (days)")]) || 84,
              "Purchase Order":
                parseFloat(
                  r[col("Purchase Order (days)")] || r[col("Bulk Order (days)")]
                ) || 70,
              Production: parseFloat(r[col("Production (days)")]) || 42,
              QC: parseFloat(r[col("QC (days)")]) || 14,
              "Ship Date": 0,
              DDP: 0,
            },
          });
        }
        const added = parsed.filter((v) => !v._up).length,
          updated = parsed.filter((v) => v._up).length;
        setVendors((vs) => {
          const names = parsed.map((v) => v.name.toLowerCase());
          return [
            ...vs.filter((v) => !names.includes(v.name.toLowerCase())),
            ...parsed.map((v) => ({ ...v, _up: undefined })),
          ];
        });
        setMsg({ t: "ok", m: `✓ ${added} added, ${updated} updated.` });
      } catch (err) {
        setMsg({ t: "err", m: "Parse error: " + err.message });
      }
    };
    reader.readAsArrayBuffer(file);
  }

  if (editing === "new")
    return (
      <div>
        <div style={{ fontSize: 13, color: TH.textMuted, marginBottom: 20 }}>
          Add New Vendor
        </div>
        <VendorForm
          taskTemplates={taskTemplates}
          onSave={(v) => {
            setVendors((vs) => [...vs, { ...v, id: uid() }]);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  if (editing) {
    const v = vendors.find((x) => x.id === editing);
    return (
      <div>
        <div style={{ fontSize: 13, color: TH.textMuted, marginBottom: 20 }}>
          Edit Vendor
        </div>
        <VendorForm
          vendor={v}
          isEdit={true}
          taskTemplates={taskTemplates}
          onSave={(u) => {
            setVendors((vs) => vs.map((x) => (x.id === editing ? u : x)));
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  const visible = vendors.filter(
    (v) =>
      !search ||
      v.name.toLowerCase().includes(search.toLowerCase()) ||
      v.country.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div>
      <div style={{ ...S.card, marginBottom: 18 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: TH.text,
                marginBottom: 3,
              }}
            >
              Upload Vendor Excel
            </div>
            <div style={{ fontSize: 12, color: TH.textMuted }}>
              Use the template below — adds new vendors, updates existing by
              name.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                if (!window.XLSX) {
                  alert("XLSX library loading, try again.");
                  return;
                }
                const headers = [
                  "Vendor Name",
                  "Country of Origin",
                  "Transit Days (to US)",
                  "MOQ",
                  "Contact Name",
                  "Contact Email",
                  "Category Specialties",
                  "Sub-Categories",
                  "Concept (days)",
                  "Design (days)",
                  "Tech Pack (days)",
                  "Costing (days)",
                  "Sampling (days)",
                  "Revision (days)",
                  "Purchase Order (days)",
                  "Production (days)",
                  "QC (days)",
                ];
                const example = [
                  "Blue Star Apparel",
                  "China",
                  "21",
                  "500",
                  "Wei Chen",
                  "wei@bluestar.cn",
                  "Denim, Shorts",
                  "Slim Fit, Cargo",
                  "168",
                  "154",
                  "140",
                  "126",
                  "112",
                  "84",
                  "70",
                  "42",
                  "14",
                ];
                const ws = window.XLSX.utils.aoa_to_sheet([headers, example]);
                ws["!cols"] = headers.map(() => ({ wch: 22 }));
                const wb = window.XLSX.utils.book_new();
                window.XLSX.utils.book_append_sheet(wb, ws, "Vendors");
                window.XLSX.writeFile(wb, "ROF_Vendor_Template.xlsx");
              }}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: `1px solid ${TH.primary}`,
                background: TH.primary + "10",
                color: TH.primary,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              ⬇ Download Template
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls"
              style={{ display: "none" }}
              onChange={handleFile}
            />
            <button
              onClick={() => fileRef.current.click()}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: `1px solid ${TH.border}`,
                background: TH.surfaceHi,
                color: TH.text,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              📂 Upload Excel
            </button>
          </div>
        </div>
        {msg && (
          <div
            style={{
              marginTop: 12,
              padding: "8px 14px",
              borderRadius: 8,
              background: msg.t === "ok" ? "#ECFDF5" : "#FEF2F2",
              color: msg.t === "ok" ? "#047857" : "#B91C1C",
              fontSize: 13,
            }}
          >
            {msg.m}
          </div>
        )}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
          gap: 12,
        }}
      >
        <input
          style={{ ...S.inp, marginBottom: 0, flex: 1 }}
          placeholder="Search vendors..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          onClick={() => setEditing("new")}
          style={{ ...S.btn, whiteSpace: "nowrap", flexShrink: 0 }}
        >
          + Add Vendor
        </button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {visible.map((v) => (
          <div
            key={v.id}
            style={{
              ...S.card,
              display: "flex",
              gap: 14,
              alignItems: "flex-start",
            }}
          >
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: TH.text,
                  marginBottom: 2,
                }}
              >
                {v.name}
              </div>
              <div style={{ fontSize: 12, color: TH.textMuted }}>
                🌏 {v.country} · Transit {v.transitDays}d · MOQ{" "}
                {v.moq?.toLocaleString()} · {v.contact}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  marginTop: 6,
                  flexWrap: "wrap",
                }}
              >
                {v.categories.map((c) => (
                  <span
                    key={c}
                    style={{
                      fontSize: 11,
                      padding: "2px 9px",
                      borderRadius: 10,
                      background: TH.surfaceHi,
                      border: `1px solid ${TH.border}`,
                      color: TH.textSub2,
                    }}
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <button
                onClick={() => setEditing(v.id)}
                style={{
                  padding: "5px 12px",
                  borderRadius: 7,
                  border: `1px solid ${TH.border}`,
                  background: "none",
                  color: TH.textMuted,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 12,
                }}
              >
                Edit
              </button>
              <button
                onClick={() => {
                  appConfirm("You are about to remove this vendor. This action cannot be undone.", "Remove", () => setVendors((vs) => vs.filter((x) => x.id !== v.id)));
                }}
                style={{
                  padding: "5px 12px",
                  borderRadius: 7,
                  border: "1px solid #FCA5A5",
                  background: "none",
                  color: "#B91C1C",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 12,
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        {visible.length === 0 && (
          <div
            style={{
              textAlign: "center",
              color: TH.textMuted,
              padding: "24px",
              fontSize: 13,
            }}
          >
            No vendors found.
          </div>
        )}
      </div>
    </div>
  );
}

export default VendorManager;
