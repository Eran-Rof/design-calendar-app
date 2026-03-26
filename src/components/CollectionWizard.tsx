import React, { useState, useEffect, useRef } from "react";
import { TH } from "../utils/theme";
import { S } from "../utils/styles";
import { STATUS_CONFIG, DEFAULT_TASK_TEMPLATES, GENDERS, CATEGORIES, CHANNEL_TYPES, DEFAULT_CUSTOMERS, BRANDS } from "../utils/constants";
import { uid, formatDate, addDays, diffDays, parseLocalDate, toDateStr, addDaysForPhase, diffDaysForPhase, getBrand, diffBusinessDays, addBusinessDays, getDaysUntil } from "../utils/dates";
import { generateTasks, getChannelForCustomer } from "../utils/helpers";
import { DateInput, LeadTimeCell } from "./DateInput";

// ─── DEFERRED DATE INPUT — only commits on blur/enter, not on every keystroke ─
function DeferredDateInput({ value, onCommit, style }) {
  const [local, setLocal] = useState(value || "");
  useEffect(() => { setLocal(value || ""); }, [value]);
  function commit() {
    if (local && local !== value) onCommit(local);
  }
  return (
    <input
      type="date"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") setLocal(value || ""); }}
      style={{ ...style, cursor: "pointer" }}
    />
  );
}

// ─── DAYS BACK INPUT (deferred commit – no DDP warning mid-typing) ──────────
function DaysBackInput({ value, onCommit }) {
  const [local, setLocal] = useState(String(value));
  useEffect(() => {
    setLocal(String(value));
  }, [value]);
  function commit() {
    const n = parseInt(local);
    if (!isNaN(n) && n >= 0) onCommit(n);
    else setLocal(String(value));
  }
  return (
    <input
      type="number"
      value={local}
      min="0"
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") setLocal(String(value));
      }}
      style={{
        width: 75,
        padding: "5px 8px",
        borderRadius: 6,
        border: `1px solid ${TH.border}`,
        background: "#FFFFFF",
        color: TH.text,
        fontFamily: "inherit",
        fontSize: 13,
        textAlign: "center",
        outline: "none",
      }}
    />
  );
}


// ─── PREV TASK INPUT (deferred commit – no DDP warning mid-typing) ────────────
function PrevTaskInput({ fromPrev, onCommit }) {
  const [local, setLocal] = useState(fromPrev != null ? String(fromPrev) : "");
  useEffect(() => {
    setLocal(fromPrev != null ? String(fromPrev) : "");
  }, [fromPrev]);
  function commit() {
    const n = parseInt(local);
    if (!isNaN(n) && n >= 0) onCommit(n);
    else setLocal(fromPrev != null ? String(fromPrev) : "");
  }
  return (
    <input
      type="number"
      min="0"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") setLocal(fromPrev != null ? String(fromPrev) : "");
      }}
      style={{
        width: 64,
        padding: "4px 6px",
        borderRadius: 6,
        border: `1px solid ${TH.border}`,
        background: "#FFFFFF",
        color: TH.text,
        fontFamily: "inherit",
        fontSize: 12,
        textAlign: "center",
        outline: "none",
      }}
    />
  );
}

// ─── COLLECTION WIZARD ────────────────────────────────────────────────────────
function CollectionWizard({ vendors, team, customers, seasons, orderTypes, onSave, onClose, taskTemplates, genders: genderList, genderSizes }) {
  const [step, setStep] = useState(1);

  // Compute initial recommended vendor for Denim (default category)
  const initialMatchV = vendors.filter(
    (v) => v.categories.length === 0 || v.categories.includes("Denim")
  );
  const initialVendorId =
    initialMatchV.length > 0 ? initialMatchV[0].id : vendors[0]?.id || "";

  // Calculate DDP from vendor lead times: DDP = today + max(lead days) + transit
  function calcDdpFromVendor(vendorId) {
    const v = vendors.find((vv) => vv.id === vendorId);
    if (!v) return "";
    // Use task templates + vendor overrides to find max lead time
    const templates = (taskTemplates && taskTemplates.length > 0) ? taskTemplates : DEFAULT_TASK_TEMPLATES;
    const overrides = v.leadOverrides || v.lead || {};
    const leadValues = templates.map(tpl => {
      const val = overrides[tpl.phase] !== undefined ? overrides[tpl.phase] : tpl.daysBeforeDDP;
      return Number(val) || 0;
    }).filter(x => x > 0);
    const maxLead = leadValues.length > 0 ? Math.max(...leadValues) : 168;
    const total = maxLead + (v.transitDays || 21);
    return addDays(new Date().toISOString().split("T")[0], total);
  }

  const initialDdp = calcDdpFromVendor(initialVendorId);

  const [form, setForm] = useState({
    brand: "ring-of-fire",
    collection: "",
    season: "Fall",
    year: new Date().getFullYear(),
    gender: "Men's",
    category: "Denim",
    vendorId: initialVendorId,
    ddpDate: initialDdp,
    customerShipDate: initialDdp ? addDays(initialDdp, 24) : "",
    cancelDate: initialDdp ? addDays(addDays(initialDdp, 24), 6) : "",
    pdId: team.filter((m) => m.role === "Product Developer")[0]?.id || "",
    designerId: team.filter((m) => m.role === "Designer")[0]?.id || "",
    graphicId: team.filter((m) => m.role === "Graphic Artist")[0]?.id || "",
    customer: "Ross",
    orderType: "Projected",
    channelType: "Off-Price (Ross, TJX)",
    sampleDueDate: "",
  });
  // Gender-specific sizes (auto-filled when gender changes)
  const [selectedSizes, setSelectedSizes] = useState(() => (genderSizes && genderSizes["Men's"]) || []);
  // Editable preview phases: [{name, daysBack, due, edited}]
  const [editPhases, setEditPhases] = useState([]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Step 2 lead times — [{phase, days}] in template order, controlled state for cascade
  const [step2Leads, setStep2Leads] = useState([]);

  function initStep2Leads(vendorId) {
    const v = vendors.find(vv => vv.id === vendorId);
    const overrides = v ? (v.leadOverrides || v.lead || {}) : {};
    const tpls = (taskTemplates && taskTemplates.length > 0) ? taskTemplates : [];
    setStep2Leads(
      tpls
        .filter(t => t.phase !== "DDP" && t.phase !== "Ship Date")
        .map(t => ({ phase: t.phase, days: overrides[t.phase] ?? t.daysBeforeDDP ?? 0 }))
    );
  }

  function applyStep2Update(idx, newDays) {
    setStep2Leads(prev => {
      // If step2Leads was never initialized (templates loaded after mount), seed from displayLeads
      const leads = prev.length > 0 ? [...prev] : [...displayLeads];
      const delta = newDays - (leads[idx]?.days ?? newDays);
      leads[idx] = { ...leads[idx], days: newDays };
      // Cascade: shift all subsequent tasks by same delta
      for (let i = idx + 1; i < leads.length; i++) {
        leads[i] = { ...leads[i], days: Math.max(0, leads[i].days + delta) };
      }
      // Sync to selV.leadOverrides so generateTasks picks it up
      if (selV) {
        const map = {};
        leads.forEach(l => { map[l.phase] = l.days; });
        selV.leadOverrides = map;
        if (selV.lead) leads.forEach(l => { selV.lead[l.phase] = l.days; });
      }
      return leads;
    });
    set("_leadOverride", Date.now());
  }

  // When step2Leads change, immediately reflect updated dates in editPhases below
  useEffect(() => {
    if (step !== 2 || !form.ddpDate || step2Leads.length === 0) return;
    setEditPhases(eps => {
      if (!eps.length) return eps;
      return eps.map(ep => {
        const lead = step2Leads.find(l => l.phase === ep.name);
        if (!lead) return ep; // DDP, Ship Date — keep unchanged
        const newDue = addDaysForPhase(form.ddpDate, -lead.days, ep.name);
        return { ...ep, due: newDue, daysBack: lead.days, edited: true };
      });
    });
  }, [step2Leads]);

  // (creationDateWarn removed — silently clamp on step 2 load instead of blocking dialog)

  const brand = getBrand(form.brand);
  const isPriv = brand.isPrivateLabel;
  const matchV = form.category
    ? vendors.filter(
        (v) => v.categories.length === 0 || v.categories.includes(form.category)
      )
    : vendors;
  const selV = vendors.find((v) => v.id === form.vendorId);
  const byRole = (r) => team.filter((m) => m.role === r);

  // Computed lead times for step 2 — used by both the table and applyStep2Update
  // step2Leads is authoritative when populated; falls back to template+vendor values
  const displayLeads = step2Leads.length > 0 ? step2Leads : (
    (taskTemplates && taskTemplates.length > 0 ? taskTemplates : [])
      .filter((t: any) => t.phase !== "DDP" && t.phase !== "Ship Date")
      .map((t: any) => {
        const overrides = selV ? (selV.leadOverrides || selV.lead || {}) : {};
        return { phase: t.phase, days: overrides[t.phase] ?? t.daysBeforeDDP ?? 0 };
      })
  );

  // Today's date string — no task may be scheduled before this
  const todayStr = new Date().toISOString().split("T")[0];

  // Build preview tasks from editPhases
  const previewTasks =
    (() => {
    try {
      return form.ddpDate && form.vendorId ? generateTasks({ ...form, vendors, taskTemplates }) : [];
    } catch(e) {
      console.error("[generateTasks error]", e);
      return [];
    }
  })();

  // Proportional resize helper: compress pre-Production phases so first task = today, DDP unchanged
  // Pre-PO phases use business-day spans; post-PO phases stay on calendar days.
  function applyProportionalResize(rawPhases) {
    const ddpDate = form.ddpDate;
    const prodIdx = rawPhases.findIndex((p) => p.name === "Production");
    const prePhases = prodIdx >= 0 ? rawPhases.slice(0, prodIdx) : rawPhases;
    const postPhases = prodIdx >= 0 ? rawPhases.slice(prodIdx) : [];
    if (prePhases.length === 0) return rawPhases;
    const origFirstDue = prePhases[0].due;
    const origProdDue = prodIdx >= 0 ? rawPhases[prodIdx].due : ddpDate;
    // Use business days for the pre-PO span
    const origSpan = diffBusinessDays(origProdDue, origFirstDue);
    const newSpan = diffBusinessDays(origProdDue, todayStr);
    const resized = prePhases.map((p) => {
      if (origSpan <= 0)
        return {
          ...p,
          due: todayStr,
          daysBack: diffBusinessDays(ddpDate, todayStr),
          edited: true,
        };
      const ratio = origSpan > 0 ? diffBusinessDays(p.due, origFirstDue) / origSpan : 0;
      const newDue = addBusinessDays(todayStr, Math.round(ratio * newSpan));
      return {
        ...p,
        due: newDue,
        daysBack: diffBusinessDays(ddpDate, newDue),
        edited: true,
      };
    });
    return [...resized, ...postPhases];
  }

  // When we have vendor + DDP on step 2, initialize editPhases from generated tasks
  // Enforce: no task date may be before today (creation date)
  useEffect(() => {
    if (step === 2 && previewTasks.length > 0 && editPhases.length === 0) {
      const rawPhases = previewTasks.map((t) => ({
        id: t.id,
        name: t.phase,
        due: t.due,
        daysBack: diffDaysForPhase(form.ddpDate, t.due, t.phase),
      }));
      const firstTask = rawPhases[0];
      if (firstTask && firstTask.due < todayStr) {
        // Clamp: shift ALL tasks so first task = today, cascade forward
        // Pre-PO phases shift by business days; post-PO by calendar days.
        const delta = diffDays(todayStr, firstTask.due);
        const clampedPhases = rawPhases.map((p) => ({
          ...p,
          due: addDaysForPhase(p.due, delta, p.name),
          daysBack: diffDaysForPhase(form.ddpDate, addDaysForPhase(p.due, delta, p.name), p.name),
          edited: true,
        }));
        const ddpPhase = clampedPhases.find((p) => p.name === "DDP");
        const newDDP = ddpPhase?.due;
        // Silently accept the shifted DDP so the user isn't interrupted on page transition
        if (newDDP && newDDP !== form.ddpDate) {
          setForm(f => ({
            ...f,
            ddpDate: newDDP,
            customerShipDate: addDays(newDDP, 24),
            cancelDate: addDays(addDays(newDDP, 24), 6),
          }));
        }
        setEditPhases(clampedPhases);
      } else {
        setEditPhases(rawPhases);
      }
    }
  }, [step, previewTasks.length, editPhases.length]);

  // When vendor changes, recalc DDP from vendor lead times, then recalc ship/cancel
  useEffect(() => {
    if (form.vendorId) {
      const newDdp = calcDdpFromVendor(form.vendorId);
      if (newDdp) {
        setForm((f) => ({
          ...f,
          ddpDate: newDdp,
          customerShipDate: addDays(newDdp, 24),
          cancelDate: addDays(addDays(newDdp, 24), 6),
        }));
      }
      // Re-initialize step 2 lead times from new vendor's overrides
      initStep2Leads(form.vendorId);
    }
  }, [form.vendorId]);

  // Re-initialize step2Leads when taskTemplates finish loading (if empty at mount time)
  useEffect(() => {
    if (form.vendorId && taskTemplates && taskTemplates.length > 0 && step2Leads.length === 0) {
      initStep2Leads(form.vendorId);
    }
  }, [taskTemplates?.length]);

  // When DDP changes manually, recalc ship/cancel
  useEffect(() => {
    if (form.ddpDate && form.vendorId) {
      set("customerShipDate", addDays(form.ddpDate, 24));
      set("cancelDate", addDays(addDays(form.ddpDate, 24), 6));
    }
  }, [form.ddpDate]);

  // When customer changes, auto-fill channel type
  useEffect(() => {
    if (form.customer) {
      const ch = getChannelForCustomer(form.customer);
      if (ch) set("channelType", ch);
    }
  }, [form.customer]);

  const [ddpWarn, setDdpWarn] = useState(null);
  const [pendingPhaseEdit, setPendingPhaseEdit] = useState(null);

  function applyPhaseDue(idx, newDue) {
    setEditPhases((eps) => {
      const updated = [...eps];
      const delta = diffDays(newDue, updated[idx].due);
      updated[idx] = {
        ...updated[idx],
        due: newDue,
        daysBack: diffDaysForPhase(form.ddpDate, newDue, updated[idx].name),
        edited: true,
      };
      for (let i = idx + 1; i < updated.length; i++) {
        // Cascade as calendar-day shift — phase type governs user input interpretation only
        const nd = addDays(updated[i].due, delta);
        updated[i] = {
          ...updated[i],
          due: nd,
          daysBack: diffDaysForPhase(form.ddpDate, nd, updated[i].name),
          edited: true,
        };
      }
      return updated;
    });
  }

  // Proportionally compress/expand all phases between the changed phase and DDP
  // so that DDP stays fixed. The changed phase gets its requested date;
  // every phase between it and DDP is scaled to fit the remaining span.
  function proportionalResizePhases(idx, newDue) {
    const phases = [...editPhases];
    const ddpIdx = phases.findIndex((e) => e.name === "DDP");
    if (ddpIdx < 0) return;
    const ddpDue = phases[ddpIdx].due;

    // Set the changed phase to the new date
    phases[idx] = {
      ...phases[idx],
      due: newDue,
      daysBack: diffDaysForPhase(ddpDue, newDue, phases[idx].name),
      edited: true,
    };

    // Phases between changed+1 and ddpIdx-1 get proportionally distributed
    const afterIdx = idx + 1;
    const beforeDDP = ddpIdx; // exclusive
    const count = beforeDDP - afterIdx;
    if (count > 0) {
      const newStart = newDue;           // start of the window
      const windowEnd = ddpDue;          // end = DDP stays fixed
      const totalSpan = diffDays(windowEnd, newStart);
      const origStart = editPhases[idx].due;
      const origEnd = editPhases[ddpIdx].due;
      const origSpan = diffDays(origEnd, origStart);

      for (let i = afterIdx; i < beforeDDP; i++) {
        if (origSpan <= 0) {
          // Degenerate: all collapse to newStart
          phases[i] = { ...phases[i], due: newStart, daysBack: diffDaysForPhase(ddpDue, newStart, phases[i].name), edited: true };
        } else {
          const ratio = diffDays(editPhases[i].due, origStart) / origSpan;
          const nd = addDays(newStart, Math.round(ratio * totalSpan));
          phases[i] = { ...phases[i], due: nd, daysBack: diffDaysForPhase(ddpDue, nd, phases[i].name), edited: true };
        }
      }
    }

    // Phases at/after DDP stay unchanged (DDP itself was not moved)
    setEditPhases(phases);
  }

  function updatePhaseDue(idx, newDue) {
    // Check if DDP row is being changed or if cascade would affect DDP
    const ep = editPhases[idx];
    const isDDP = ep.name === "DDP";
    if (isDDP) {
      const oldDDP = ep.due;
      if (newDue !== oldDDP) {
        setDdpWarn({ idx, newDue, oldDDP });
        return;
      }
    }
    // Check if cascading would push DDP
    const ddpIdx = editPhases.findIndex((e) => e.name === "DDP");
    if (ddpIdx > idx) {
      const delta = diffDays(newDue, editPhases[idx].due);
      const newDDPDue = addDays(editPhases[ddpIdx].due, delta);
      if (newDDPDue !== editPhases[ddpIdx].due && delta > 0) {
        const affectedCount = ddpIdx - idx;
        setDdpWarn({
          idx,
          newDue,
          oldDDP: editPhases[ddpIdx].due,
          newDDP: newDDPDue,
          cascade: true,
          affectedCount,
        });
        return;
      }
    }
    applyPhaseDue(idx, newDue);
  }

  function updatePhaseDaysBack(idx, newDaysBack) {
    const phase = editPhases[idx]?.name ?? "";
    const newDue = addDaysForPhase(form.ddpDate, -newDaysBack, phase);
    updatePhaseDue(idx, newDue);
  }

  function buildFinalTasks() {
    // Use editPhases dates instead of auto-generated ones
    return previewTasks.map((t) => {
      const ep = editPhases.find((e) => e.name === t.phase);
      return ep ? { ...t, due: ep.due, originalDue: ep.due } : t;
    });
  }

  const s1ok = form.collection && form.brand && form.season && form.category;
  const s2ok = form.vendorId && form.ddpDate;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 26 }}>
        {[1, 2, 3].map((s) => (
          <div
            key={s}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              background:
                step >= s
                  ? `linear-gradient(90deg,${TH.primary},${TH.primaryLt})`
                  : TH.border,
              transition: "all 0.3s",
            }}
          />
        ))}
      </div>

      {step === 1 && (
        <div>
          <div style={{ fontSize: 12, color: TH.textMuted, marginBottom: 18 }}>
            Step 1 of 2 — Brand, Collection & Team
          </div>
          <label style={S.lbl}>Brand</label>
          <select
            style={S.inp}
            value={form.brand}
            onChange={(e) => set("brand", e.target.value)}
          >
            {BRANDS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.isPrivateLabel ? " (PL)" : ""}
              </option>
            ))}
          </select>
          {isPriv && (
            <div
              style={{
                background: "#F5F3FF",
                border: "1px solid #C4B5FD",
                borderRadius: 8,
                padding: "10px 14px",
                marginBottom: 14,
                fontSize: 12,
                color: "#6D28D9",
              }}
            >
              ✦ Private label — Line Review & Compliance/Testing auto-added
            </div>
          )}
          <label style={S.lbl}>Collection Name</label>
          <input
            style={S.inp}
            value={form.collection}
            onChange={(e) => set("collection", e.target.value)}
            placeholder="e.g. Heritage Series Fall 2025"
          />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr 1fr",
              gap: 14,
            }}
          >
            <div>
              <label style={S.lbl}>Season</label>
              <select
                style={{ ...S.inp, marginBottom: 0 }}
                value={form.season}
                onChange={(e) => set("season", e.target.value)}
              >
                {seasons.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={S.lbl}>Year</label>
              <select
                style={{ ...S.inp, marginBottom: 0 }}
                value={form.year}
                onChange={(e) => set("year", parseInt(e.target.value))}
              >
                {[2024, 2025, 2026, 2027, 2028].map((y) => (
                  <option key={y}>{y}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={S.lbl}>Gender</label>
              <select
                style={{ ...S.inp, marginBottom: 0 }}
                value={form.gender}
                onChange={(e) => {
                  set("gender", e.target.value);
                  if (genderSizes && genderSizes[e.target.value]?.length > 0) {
                    setSelectedSizes(genderSizes[e.target.value]);
                  }
                }}
              >
                {(genderList || GENDERS).map((g) => (
                  <option key={typeof g === "string" ? g : g.label}>{typeof g === "string" ? g : g.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={S.lbl}>Category</label>
              <select
                style={{ ...S.inp, marginBottom: 0 }}
                value={form.category}
                onChange={(e) => {
                  const newCat = e.target.value;
                  const newMatchV = vendors.filter(
                    (v) =>
                      v.categories.length === 0 || v.categories.includes(newCat)
                  );
                  const newVendorId =
                    newMatchV.length > 0 ? newMatchV[0].id : "";
                  set("category", newCat);
                  set("vendorId", newVendorId);
                }}
              >
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ height: 16 }} />
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}
          >
            <div>
              <label style={S.lbl}>Customer</label>
              {/* FIX: pure select dropdown - no datalist combo issue */}
              <select
                style={S.inp}
                value={form.customer}
                onChange={(e) => set("customer", e.target.value)}
              >
                <option value="">-- Select Customer --</option>
                {(customers || DEFAULT_CUSTOMERS).map((c) => {
                  const name = typeof c === "string" ? c : c.name;
                  return <option key={name} value={name}>{name}</option>;
                })}
              </select>
            </div>
            <div>
              <label style={S.lbl}>Order Type</label>
              <select
                style={S.inp}
                value={form.orderType}
                onChange={(e) => set("orderType", e.target.value)}
              >
                {orderTypes.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </div>
          </div>
          <label style={S.lbl}>
            Channel Type{" "}
            <span style={{ textTransform: "none", fontWeight: 400 }}>
              (auto-fills from customer)
            </span>
          </label>
          <select
            style={S.inp}
            value={form.channelType}
            onChange={(e) => set("channelType", e.target.value)}
          >
            <option value="">-- Select --</option>
            {CHANNEL_TYPES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <span style={S.sec}>Collection Team</span>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 12,
            }}
          >
            {[
              ["Product Developer", "pdId"],
              ["Designer", "designerId"],
              ["Graphic Artist", "graphicId"],
            ].map(([role, key]) => (
              <div key={key}>
                <label style={S.lbl}>{role}</label>
                <select
                  style={{ ...S.inp, marginBottom: 0 }}
                  value={form[key]}
                  onChange={(e) => set(key, e.target.value)}
                >
                  <option value="">-- None --</option>
                  {byRole(role).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <div style={{ height: 16 }} />
          <button
            disabled={!s1ok}
            onClick={() => setStep(2)}
            style={{
              ...S.btn,
              width: "100%",
              padding: "12px",
              fontSize: 14,
              opacity: s1ok ? 1 : 0.5,
            }}
          >
            Select Vendor →
          </button>
        </div>
      )}

      {step === 2 && (
        <div>
          <div style={{ fontSize: 12, color: TH.textMuted, marginBottom: 18 }}>
            Step 2 of 2 — Vendor & Dates
          </div>
          <label style={S.lbl}>
            Vendor{" "}
            <span style={{ textTransform: "none", color: TH.textMuted }}>
              — {form.category} specialists shown first
            </span>
          </label>
          <select
            style={S.inp}
            value={form.vendorId}
            onChange={(e) => set("vendorId", e.target.value)}
          >
            <option value="">-- Select Vendor --</option>
            {matchV.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.country})
              </option>
            ))}
            {vendors.filter((v) => !matchV.includes(v)).length > 0 && (
              <option disabled>── Other vendors ──</option>
            )}
            {vendors
              .filter((v) => !matchV.includes(v))
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.country})
                </option>
              ))}
          </select>

          {selV && (
            <div style={{ ...S.card, marginBottom: 16 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  marginBottom: 14,
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 700,
                      color: TH.text,
                      marginBottom: 2,
                    }}
                  >
                    {selV.name}
                  </div>
                  <div style={{ fontSize: 12, color: TH.textMuted }}>
                    🌏 {selV.country} · ⛵ {selV.transitDays}d transit · MOQ{" "}
                    {selV.moq?.toLocaleString()}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {selV.categories.map((c) => (
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
              <div style={{ fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                Task Lead Times — Days Before DDP (editable)
              </div>
              {/* Lead times table */}
              {(() => {
                const leads = displayLeads;
                return (
                  <div style={{ border: `1px solid ${TH.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 4 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 100px 100px 90px", background: TH.surfaceHi, padding: "7px 12px", fontSize: 10, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: `1px solid ${TH.border}` }}>
                      <span>Phase</span>
                      <span style={{ textAlign: "center" }}>Bus. Days Before DDP</span>
                      <span style={{ textAlign: "center" }}>From Prev (bus. days)</span>
                      <span style={{ textAlign: "center" }}>Due Date</span>
                    </div>
                    {leads.map((lead, idx) => {
                      const calcDate = form.ddpDate ? addDaysForPhase(form.ddpDate, -lead.days, lead.phase) : "";
                      const prevCalcDate = idx > 0 && form.ddpDate ? addDaysForPhase(form.ddpDate, -leads[idx - 1].days, leads[idx - 1].phase) : null;
                      const fromPrev = prevCalcDate && calcDate ? diffDaysForPhase(calcDate, prevCalcDate, lead.phase) : null;
                      return (
                        <div key={lead.phase} style={{ display: "grid", gridTemplateColumns: "1fr 100px 100px 90px", padding: "7px 12px", borderBottom: idx < leads.length - 1 ? `1px solid ${TH.border}` : "none", alignItems: "center", background: idx % 2 === 0 ? "#fff" : TH.surfaceHi }}>
                          <div style={{ fontSize: 13, color: TH.text, fontWeight: 600 }}>{lead.phase}</div>
                          <div style={{ textAlign: "center" }}>
                            <LeadTimeCell
                              value={lead.days}
                              onCommit={n => applyStep2Update(idx, n)}
                            />
                          </div>
                          <div style={{ textAlign: "center" }}>
                            {fromPrev !== null ? (
                              <LeadTimeCell
                                value={fromPrev}
                                onCommit={n => {
                                  if (!form.ddpDate || !prevCalcDate) return;
                                  const newDate = addDaysForPhase(prevCalcDate, n, lead.phase);
                                  const newDays = Math.round(diffDaysForPhase(form.ddpDate, newDate, lead.phase));
                                  applyStep2Update(idx, Math.max(0, newDays));
                                }}
                              />
                            ) : <span style={{ fontSize: 12, color: TH.textMuted }}>—</span>}
                          </div>
                          <div style={{ textAlign: "center", fontSize: 12, color: TH.primary, fontWeight: 600 }}>
                            {calcDate ? formatDate(calcDate) : "—"}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}

          <label style={S.lbl}>DDP Date (Delivered Duty Paid)</label>
          <DateInput
            style={S.inp}
            value={form.ddpDate}
            onChange={(v) => set("ddpDate", v)}
          />

          <label style={S.lbl}>Sample Due Date</label>
          <DateInput
            style={S.inp}
            value={form.sampleDueDate}
            onChange={(v) => set("sampleDueDate", v)}
          />

          {form.ddpDate && selV && (
            <div
              style={{
                background: TH.surfaceHi,
                border: `1px solid ${TH.border}`,
                borderRadius: 10,
                padding: "12px 16px",
                marginBottom: 14,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: TH.textMuted,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  marginBottom: 10,
                }}
              >
                Auto-Calculated Dates
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 12,
                }}
              >
                <div>
                  <label style={S.lbl}>
                    Customer Ship Date{" "}
                    <span style={{ textTransform: "none", fontWeight: 400 }}>
                      (DDP +24d)
                    </span>
                  </label>
                  <DateInput
                    style={{ ...S.inp, marginBottom: 0 }}
                    value={form.customerShipDate}
                    onChange={(v) => set("customerShipDate", v)}
                  />
                </div>
                <div>
                  <label style={S.lbl}>
                    Cancel Date{" "}
                    <span style={{ textTransform: "none", fontWeight: 400 }}>
                      (Cust Ship +6d)
                    </span>
                  </label>
                  <DateInput
                    style={{ ...S.inp, marginBottom: 0 }}
                    value={form.cancelDate}
                    onChange={(v) => set("cancelDate", v)}
                  />
                </div>
              </div>
            </div>
          )}

          {form.ddpDate && selV && editPhases.length > 0 && (
            <>
          <div style={{ ...S.card, marginBottom: 16 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                flexWrap: "wrap",
                gap: 12,
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    color: TH.text,
                    marginBottom: 2,
                  }}
                >
                  {form.collection}
                </div>
                <div style={{ fontSize: 12, color: TH.textMuted }}>
                  {brand.name} · {form.gender} · {form.season} {form.year} ·{" "}
                  {form.category}
                </div>
                {form.customer && (
                  <div
                    style={{
                      fontSize: 12,
                      color: TH.primary,
                      fontWeight: 600,
                      marginTop: 2,
                    }}
                  >
                    {form.customer} · {form.orderType}
                  </div>
                )}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3,1fr)",
                  gap: 10,
                  textAlign: "center",
                }}
              >
                {[
                  ["DDP", form.ddpDate, TH.primary],
                  ["Ship", form.customerShipDate, "#065F46"],
                  ["Cancel", form.cancelDate, "#B91C1C"],
                ].map(([l, d, c]) => (
                  <div key={l}>
                    <div style={{ fontSize: 10, color: TH.textMuted }}>{l}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: c }}>
                      {formatDate(d)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div style={{ fontSize: 11, color: TH.textMuted, marginBottom: 8 }}>
            💡 Edit any date or days-back value — all later phases adjust
            automatically. DDP changes require approval.
          </div>
          <div
            style={{
              overflowY: "auto",
              marginBottom: 18,
              border: `1px solid ${TH.border}`,
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            {/* Header */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 110px 130px 110px 110px",
                gap: 0,
                padding: "8px 14px",
                background: TH.header,
                borderBottom: `1px solid ${TH.border}44`,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  color: "rgba(255,255,255,0.6)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  fontWeight: 600,
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                  lineHeight: 1.3,
                }}
              >
                Phase
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: "rgba(255,255,255,0.6)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  fontWeight: 600,
                  textAlign: "center",
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                  lineHeight: 1.3,
                }}
              >
                Days to Complete
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: "rgba(255,255,255,0.6)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  fontWeight: 600,
                  textAlign: "center",
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                  lineHeight: 1.3,
                }}
              >
                Due Date
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: "rgba(255,255,255,0.6)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  fontWeight: 600,
                  textAlign: "center",
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                  lineHeight: 1.3,
                }}
              >
                Bus. Days To DDP
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: "rgba(255,255,255,0.6)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  fontWeight: 600,
                  textAlign: "center",
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                  lineHeight: 1.3,
                }}
              >
                From Prev (bus. days)
              </span>
            </div>
            {editPhases.map((ep, i) => {
              const days = getDaysUntil(ep.due);
              const isPL =
                ep.name === "Line Review" || ep.name === "Compliance/Testing";
              const isDDP = ep.name === "DDP";
              const isPast = ep.due < todayStr && !isDDP;
              const dtcColor =
                days < 0
                  ? "#B91C1C"
                  : days <= 7
                  ? "#B45309"
                  : days <= 14
                  ? "#D97706"
                  : "#065F46";
              const dtcLabel =
                days < 0
                  ? `${Math.abs(days)}d overdue`
                  : days === 0
                  ? "Due today"
                  : `${days}d`;
              return (
                <div
                  key={ep.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 110px 130px 110px 110px",
                    gap: 0,
                    padding: "9px 14px",
                    background: isPast
                      ? "#FEF2F2"
                      : isDDP
                      ? TH.primary + "20"
                      : isPL
                      ? "#F5F3FF"
                      : i % 2 === 0
                      ? "#F9FAFB"
                      : "#FFFFFF",
                    borderBottom: `1px solid ${isPast ? "#FCA5A5" : TH.border}`,
                    alignItems: "center",
                  }}
                >
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <div
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 5,
                        background: brand.color + "22",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 11,
                        color: brand.color,
                        fontWeight: 700,
                        flexShrink: 0,
                      }}
                    >
                      {i + 1}
                    </div>
                    <span
                      style={{
                        fontSize: 14,
                        color: isDDP ? TH.primary : TH.text,
                        fontWeight: isDDP ? 700 : 600,
                      }}
                    >
                      {ep.name}
                    </span>
                    {isPL && (
                      <span
                        style={{
                          fontSize: 9,
                          color: "#6D28D9",
                          background: "#F5F3FF",
                          border: "1px solid #C4B5FD",
                          padding: "1px 5px",
                          borderRadius: 4,
                        }}
                      >
                        PL
                      </span>
                    )}
                    {ep.edited && (
                      <span
                        style={{
                          fontSize: 9,
                          color: TH.primary,
                          background: TH.primary + "15",
                          padding: "1px 5px",
                          borderRadius: 4,
                        }}
                      >
                        edited
                      </span>
                    )}
                    {isPast && (
                      <span
                        style={{
                          fontSize: 9,
                          color: "#B91C1C",
                          background: "#FEF2F2",
                          border: "1px solid #FCA5A5",
                          padding: "1px 5px",
                          borderRadius: 4,
                        }}
                      >
                        ⚠️ past
                      </span>
                    )}
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: dtcColor,
                        background: dtcColor + "15",
                        borderRadius: 6,
                        padding: "3px 8px",
                        display: "inline-block",
                      }}
                    >
                      {dtcLabel}
                    </span>
                  </div>
                  <div style={{ textAlign: "center", overflow: "hidden", paddingLeft: 4, paddingRight: 4 }}>
                    <DeferredDateInput
                      value={ep.due}
                      onCommit={(v) => updatePhaseDue(i, v)}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        padding: "5px 4px",
                        borderRadius: 6,
                        border: `1px solid ${TH.border}`,
                        background: isDDP ? TH.primary + "20" : "#FFFFFF",
                        color: isDDP ? TH.primary : TH.text,
                        fontFamily: "inherit",
                        fontSize: 11,
                        outline: "none",
                      }}
                    />
                  </div>
                  <div style={{ textAlign: "center", paddingLeft: 4, paddingRight: 4 }}>
                    {isDDP ? (
                      <span
                        style={{
                          fontSize: 13,
                          color: TH.primary,
                          fontWeight: 700,
                        }}
                      >
                        0
                      </span>
                    ) : (
                      <DaysBackInput
                        value={ep.daysBack}
                        onCommit={(v) => updatePhaseDaysBack(i, v)}
                      />
                    )}
                  </div>
                  {/* From Prev Task — editable, updates due date */}
                  <div style={{ textAlign: "center" }}>
                    {i === 0 ? (
                      <span style={{ fontSize: 12, color: TH.textMuted }}>—</span>
                    ) : (() => {
                      const prevDue = editPhases[i - 1]?.due;
                      const fromPrev = prevDue ? diffDaysForPhase(ep.due, prevDue, ep.name) : null;
                      return (
                        <PrevTaskInput
                          fromPrev={fromPrev}
                          onCommit={(n) => {
                            const newDue = addDaysForPhase(editPhases[i - 1].due, n, ep.name);
                            updatePhaseDue(i, newDue);
                          }}
                        />
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>

          {ddpWarn && (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2100, padding: 16 }}>
              <div style={{ background: "#FFFFFF", border: `1px solid ${TH.accentBdr}`, borderRadius: 16, padding: 32, maxWidth: 520, width: "100%", boxShadow: "0 40px 100px rgba(0,0,0,0.4)" }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: TH.text, marginBottom: 12 }}>⚠️ DDP Date Will Change</div>
                <div style={{ fontSize: 13, color: TH.textMuted, lineHeight: 1.65, marginBottom: 20 }}>
                  {ddpWarn.cascade ? (
                    <>
                      This change affects{" "}
                      <strong>{ddpWarn.affectedCount} phase{ddpWarn.affectedCount !== 1 ? "s" : ""}</strong> and would push the{" "}
                      <strong>DDP date</strong> from{" "}
                      <strong style={{ color: TH.primary }}>{formatDate(ddpWarn.oldDDP)}</strong> to{" "}
                      <strong style={{ color: "#B91C1C" }}>{formatDate(ddpWarn.newDDP)}</strong>.
                    </>
                  ) : (
                    <>
                      You are changing the <strong>DDP date</strong> from{" "}
                      <strong style={{ color: TH.primary }}>{formatDate(ddpWarn.oldDDP)}</strong> to{" "}
                      <strong style={{ color: "#B91C1C" }}>{formatDate(ddpWarn.newDue)}</strong>.
                    </>
                  )}
                  <br /><br />How would you like to handle this?
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {/* Option 1: Accept new DDP — cascade all later phases */}
                  <button
                    onClick={() => { applyPhaseDue(ddpWarn.idx, ddpWarn.newDue); setDdpWarn(null); }}
                    style={{ padding: "12px 20px", borderRadius: 10, border: "none", background: `linear-gradient(135deg,${TH.primary},${TH.primaryLt})`, color: "#fff", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 13, textAlign: "left" }}
                  >
                    ✓ Accept New DDP Date —{" "}
                    <span style={{ fontWeight: 400 }}>{formatDate(ddpWarn.newDDP || ddpWarn.newDue)}</span>
                  </button>
                  {/* Option 2: Proportionally resize phases — keep DDP fixed */}
                  {ddpWarn.cascade && (
                    <button
                      onClick={() => { proportionalResizePhases(ddpWarn.idx, ddpWarn.newDue); setDdpWarn(null); }}
                      style={{ padding: "12px 20px", borderRadius: 10, border: `2px solid ${TH.primary}`, background: TH.primary + "10", color: TH.primary, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 13, textAlign: "left" }}
                    >
                      ⚖️ Proportionally Resize Phase Durations —{" "}
                      <span style={{ fontWeight: 400 }}>keep DDP {formatDate(ddpWarn.oldDDP)}</span>
                    </button>
                  )}
                  {/* Option 3: Keep DDP — only move this phase, no cascade */}
                  <button
                    onClick={() => {
                      setEditPhases((prev) => prev.map((p, i) =>
                        i === ddpWarn.idx
                          ? { ...p, due: ddpWarn.newDue, daysBack: diffDays(form.ddpDate, ddpWarn.newDue), edited: true }
                          : p
                      ));
                      setDdpWarn(null);
                    }}
                    style={{ padding: "12px 20px", borderRadius: 10, border: "2px solid #065F46", background: "#ECFDF5", color: "#065F46", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 13, textAlign: "left" }}
                  >
                    📌 Keep DDP as-is —{" "}
                    <span style={{ fontWeight: 400 }}>only update this phase's date</span>
                  </button>
                  {/* Option 4: Cancel */}
                  <button
                    onClick={() => setDdpWarn(null)}
                    style={{ padding: "10px 20px", borderRadius: 10, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}
                  >
                    Cancel — keep original date
                  </button>
                </div>
              </div>
            </div>
          )}

            </>
          )}

          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={() => setStep(1)}
              style={{
                flex: 1,
                padding: "12px",
                borderRadius: 10,
                border: `1px solid ${TH.border}`,
                background: "none",
                color: TH.textMuted,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              ← Back
            </button>
            <button
              disabled={editPhases.length === 0}
              onClick={() =>
                onSave(buildFinalTasks(), {
                  gender: form.gender,
                  year: form.year,
                  customerShipDate: form.customerShipDate,
                  cancelDate: form.cancelDate,
                  customer: form.customer,
                  orderType: form.orderType,
                  channelType: form.channelType,
                  sampleDueDate: form.sampleDueDate,
                  availableSizes: selectedSizes.length > 0 ? selectedSizes : undefined,
                })
              }
              style={{ ...S.btn, flex: 2, padding: "12px", fontSize: 14, opacity: editPhases.length === 0 ? 0.5 : 1 }}
            >
              ✓ Create {editPhases.length} Tasks
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


export default CollectionWizard;
