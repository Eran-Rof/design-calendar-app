import React, { useState } from "react";
import { TH } from "../utils/theme";
import { appConfirm } from "../utils/theme";
import { S } from "../utils/styles";
import { CHANNEL_TYPES } from "../utils/constants";

function CustomerManager({ customers, setCustomers, isAdmin = false }: {
  customers: any[];
  setCustomers: (fn: any) => void;
  isAdmin?: boolean;
}) {
  const [editing, setEditing] = useState<any>(null);
  if (!isAdmin) return (
    <div style={{ padding: "20px", textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
      <div style={{ fontSize: 24, marginBottom: 8 }}>🔒</div>
      <div style={{ fontWeight: 600, color: TH.text, marginBottom: 4 }}>Admin Only</div>
      <div>Only admins can manage this section.</div>
    </div>
  );
  // null | "new" | index
  const [form, setForm] = useState({ name: "", channel: "" });

  function save() {
    const name = form.name.trim();
    if (!name) return;
    const entry = { name, channel: form.channel.trim() };
    if (editing === "new") {
      setCustomers((c: any[]) => [...c, entry]);
    } else {
      setCustomers((c: any[]) => c.map((x: any, i: number) => i === editing ? entry : x));
    }
    setEditing(null);
    setForm({ name: "", channel: "" });
  }

  if (editing !== null)
    return (
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: TH.text, marginBottom: 20 }}>
          {editing === "new" ? "Add Customer" : "Edit Customer"}
        </div>
        <label style={S.lbl}>Customer Name</label>
        <input style={S.inp} value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="e.g. Macy's" autoFocus />
        <label style={S.lbl}>Channel Type</label>
        <select style={S.inp} value={form.channel} onChange={(e) => setForm(f => ({ ...f, channel: e.target.value }))}>
          <option value="">-- Select --</option>
          {CHANNEL_TYPES.map(c => <option key={c}>{c}</option>)}
        </select>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={() => { setEditing(null); setForm({ name: "", channel: "" }); }} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button disabled={!form.name.trim()} onClick={save} style={{ ...S.btn, opacity: form.name.trim() ? 1 : 0.5 }}>Save Customer</button>
        </div>
      </div>
    );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <span style={S.sec}>Customers ({customers.length})</span>
        <button onClick={() => { setForm({ name: "", channel: "" }); setEditing("new"); }} style={S.btn}>+ Add Customer</button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {customers.map((c: any, i: number) => (
          <div key={i} style={{ ...S.card, display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: TH.text }}>{c.name || c}</div>
              {c.channel && <div style={{ fontSize: 11, color: TH.textMuted }}>{c.channel}</div>}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setForm({ name: c.name || c, channel: c.channel || "" }); setEditing(i); }} style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Edit</button>
              <button onClick={() => appConfirm("You are about to delete this customer. This action cannot be undone.", "Delete", () => setCustomers((cs: any[]) => cs.filter((_: any, j: number) => j !== i)))} style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid #FCA5A5", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      {customers.length === 0 && <div style={{ textAlign: "center", color: TH.textMuted, padding: "24px", fontSize: 13, border: `1px dashed ${TH.border}`, borderRadius: 10 }}>No customers yet.</div>}
    </div>
  );
}

export default CustomerManager;
