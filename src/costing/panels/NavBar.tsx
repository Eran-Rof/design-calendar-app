// Costing Module — top nav
import React, { useState } from "react";
import { TH } from "../../utils/theme";
import { navigate, getView } from "../helpers";
import { AskAIPanel } from "../../ai/AskAIPanel";
import type { AIGridSetters, GridContextSnapshot } from "../../ai/tools";

// Costing-flavoured starter questions. These all resolve through Ask AI's
// existing analytics tools (query_margin / style_card / customer_card /
// query_shipments) — the costing operator just gets them within reach.
const COSTING_SAMPLE_PROMPTS = [
  "Which styles had a gross margin under 18% in the last 3 months?",
  "Show me my top 10 styles by trailing-3-month sales",
  "Compare last-year vs trailing-3-month sales for RYB0412",
  "Which customers are buying less than they did last year?",
];

// Ask AI is pure Q&A here (no grid to drive), so the context is minimal and
// there are no setters to apply suggestions with.
const EMPTY_SETTERS: AIGridSetters = {};
function buildCostingContext(): GridContextSnapshot {
  return {
    columns: [],
    active_filters: {},
    row_count: 0,
    distinct: { categories: [], sub_categories: [], styles: [], genders: [], stores: [] },
  };
}

export default function CostingNavBar() {
  const view = getView();
  const [aiOpen, setAiOpen] = useState(false);

  return (
    <div style={{
      background: TH.header,
      color: "#fff",
      display: "flex",
      alignItems: "center",
      padding: "0 16px",
      height: 52,
      boxShadow: `0 2px 8px ${TH.shadow}`,
      flexShrink: 0,
      gap: 8,
    }}>
      <a href="/" style={{ color: "#fff", textDecoration: "none", fontSize: 13, marginRight: 16, opacity: 0.7 }}>
        ← PLM
      </a>
      <span style={{ fontWeight: 700, fontSize: 15, marginRight: 20 }}>
        Costing
      </span>
      <div style={{ display: "flex", gap: 2 }}>
        <button
          onClick={() => navigate("list")}
          style={navBtn(view === "list" || view === "edit")}
        >
          Projects
        </button>
        <button
          onClick={() => navigate("rfq-list")}
          style={navBtn(view === "rfq-list" || view === "rfq-edit")}
        >
          RFQs
        </button>
        <button
          onClick={() => navigate("rfq-compare")}
          style={navBtn(view === "rfq-compare")}
        >
          Compare RFQs
        </button>
        <button
          onClick={() => navigate("messages")}
          style={navBtn(view === "messages")}
        >
          Messages
        </button>
        <button
          onClick={() => navigate("settings")}
          style={navBtn(view === "settings")}
        >
          Masters
        </button>
      </div>

      {/* Ask AI launcher — opens the shared analytics assistant (Opus) with
          costing-flavoured starter questions. */}
      <button
        onClick={() => setAiOpen(true)}
        style={{ ...navBtn(false), marginLeft: "auto", border: "1px solid rgba(255,255,255,0.25)" }}
        title="Ask AI about your sales, margins, styles and customers"
      >
        ✨ Ask AI
      </button>

      {/* Vendor portal links — open the standalone /vendor app in a new tab
          (separate Supabase Auth session, so it must not replace the costing
          tab). */}
      <div style={{ display: "flex", gap: 2 }}>
        <a
          href="/vendor"
          target="_blank"
          rel="noopener noreferrer"
          style={linkBtn}
          title="Open the vendor portal in a new tab"
        >
          Vendor Portal ↗
        </a>
        <a
          href="/vendor/onboarding"
          target="_blank"
          rel="noopener noreferrer"
          style={linkBtn}
          title="Open vendor onboarding in a new tab"
        >
          Vendor Onboarding ↗
        </a>
      </div>

      {/* Ask AI slide-in panel — shared analytics assistant. appId "tangerine"
          routes to Opus + the full sales/inventory schema (constants.MODEL_BY_APP). */}
      <AskAIPanel
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        buildContext={buildCostingContext}
        setters={EMPTY_SETTERS}
        samplePrompts={COSTING_SAMPLE_PROMPTS}
        appId="tangerine"
      />
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  background: "transparent",
  color: "rgba(255,255,255,0.75)",
  border: "1px solid rgba(255,255,255,0.25)",
  borderRadius: 6,
  padding: "6px 14px",
  fontSize: 13,
  fontWeight: 400,
  cursor: "pointer",
  textDecoration: "none",
  whiteSpace: "nowrap",
  transition: "all 0.15s",
};

function navBtn(active: boolean): React.CSSProperties {
  return {
    background: active ? TH.primary : "transparent",
    color: active ? "#fff" : "rgba(255,255,255,0.75)",
    border: "none",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 13,
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
    transition: "all 0.15s",
  };
}
