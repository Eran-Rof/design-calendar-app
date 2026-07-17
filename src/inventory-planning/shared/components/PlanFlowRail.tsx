// PlanFlowRail — a slim horizontal stepper that keeps the planner oriented
// across the buy-planning flow. Rendered by PlanningShell on the flow routes
// only (Forecast → Finalize → Buy plan → Draft POs → Issue in Procurement).
//
// The app has no SPA router — every /planning/<slug> is a full page load — so
// each step is a plain <a href>. The current step is derived from the
// pathname; there is no in-page state to track. The active flow run (written
// by PlanningRunControls to localStorage under `ip_active_flow_run`) is shown
// on the right so the planner always knows which run they're steering.

import { PAL } from "../../components/styles";

// True orange for the "current step" accent. The palette's amber (PAL.yellow)
// reads as a warning colour in this app; a Tangerine-orange (already used for
// the "Sync Tangerine supply" button) lands as a forward/flow accent and ties
// the rail to its Tangerine destination.
const FLOW_ORANGE = "#EA580C";

interface FlowStep {
  n: string;            // circled numeral glyph
  label: string;
  href?: string;        // undefined → contextual (non-navigating) step
  newTab?: boolean;
  tip?: string;         // hover title
}

const STEPS: FlowStep[] = [
  {
    n: "①",
    label: "Forecast & Buys",
    href: "/planning/wholesale",
    tip: "Build the demand forecast and type your buys on the Wholesale planning grid",
  },
  {
    n: "②",
    label: "Finalize plan",
    // Contextual: the finalize decision lives on the Forecast page (Finalize
    // with my buys) and on the Supply screen (reconcile against supply). No
    // single destination — the "?" explains the two paths.
    tip: "Turn the plan into an approved buy plan — two ways to do it (see ?)",
  },
  {
    n: "③",
    label: "Buy plan",
    href: "/planning/execution",
    tip: "Review the finalized buy plan as an execution batch",
  },
  {
    n: "④",
    label: "Draft POs",
    href: "/planning/execution",
    tip: "Turn the buy plan into draft purchase orders on the Execution screen",
  },
  {
    n: "⑤",
    label: "Issue in Procurement",
    href: "/tangerine?m=purchase_orders",
    newTab: true,
    tip: "Open Tangerine Procurement to issue the drafted POs (new tab)",
  },
];

const FINALIZE_TIP =
  "Two ways to finalize the plan:\n\n" +
  "• Finalize with my buys — takes your typed Buy column verbatim, skips " +
  "supply reconciliation, and approves the run. Fastest when you already " +
  "trust your numbers.\n\n" +
  "• Reconcile against supply first — nets demand against on-hand + inbound " +
  "supply and computes recommended buys before you finalize.\n\n" +
  "Either path ends with an approved buy plan you take to the Buy plan step.";

// Which step index(es) the current pathname maps to. Steps before the first
// active index render as "done"; active steps get the orange accent; later
// steps are muted/upcoming.
function activeStepsForPath(pathname: string): number[] {
  const p = (pathname || "").replace(/\/+$/, "") || "/planning";
  if (p === "/planning" || p.startsWith("/planning/wholesale")) return [0, 1];
  if (p.startsWith("/planning/supply") || p.startsWith("/planning/reconcile")) return [1];
  if (p.startsWith("/planning/execution")) return [2, 3];
  return [0];
}

function readActiveRunName(): string | null {
  try {
    const raw = localStorage.getItem("ip_active_flow_run");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { runId?: string; name?: string };
    return parsed?.name?.trim() ? parsed.name : null;
  } catch {
    return null;
  }
}

export default function PlanFlowRail({ pathname }: { pathname?: string }) {
  const path = pathname ?? (typeof window !== "undefined" ? window.location.pathname : "/planning");
  const active = activeStepsForPath(path);
  const firstActive = active[0];
  const runName = readActiveRunName();

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        height: 36,
        padding: "0 16px",
        background: PAL.panel,
        borderBottom: `1px solid ${PAL.border}`,
        fontSize: 12,
        overflowX: "auto",
        whiteSpace: "nowrap",
      }}
    >
      {STEPS.map((step, i) => {
        const isCurrent = active.includes(i);
        const isDone = i < firstActive;
        const color = isCurrent ? FLOW_ORANGE : isDone ? PAL.textDim : PAL.textMuted;
        const weight = isCurrent ? 700 : 500;

        const inner = (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color,
              fontWeight: weight,
            }}
          >
            <span style={{ fontSize: 14, lineHeight: 1 }}>{step.n}</span>
            <span>{step.label}</span>
            {/* Step ② carries the "?" that explains the two finalize paths. */}
            {i === 1 && (
              <span
                title={FINALIZE_TIP}
                aria-label="How finalizing works"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 15,
                  height: 15,
                  borderRadius: 999,
                  border: `1px solid ${isCurrent ? FLOW_ORANGE : PAL.border}`,
                  color: isCurrent ? FLOW_ORANGE : PAL.textDim,
                  fontSize: 10,
                  fontWeight: 700,
                  cursor: "help",
                }}
              >
                ?
              </span>
            )}
          </span>
        );

        const node = step.href ? (
          <a
            key={step.n}
            href={step.href}
            target={step.newTab ? "_blank" : undefined}
            rel={step.newTab ? "noopener noreferrer" : undefined}
            title={step.tip}
            style={{
              textDecoration: "none",
              padding: "4px 8px",
              borderRadius: 6,
              background: isCurrent ? `${FLOW_ORANGE}1A` : "transparent",
            }}
          >
            {inner}
          </a>
        ) : (
          <span
            key={step.n}
            title={step.tip}
            style={{
              padding: "4px 8px",
              borderRadius: 6,
              background: isCurrent ? `${FLOW_ORANGE}1A` : "transparent",
            }}
          >
            {inner}
          </span>
        );

        return (
          <span key={step.n} style={{ display: "inline-flex", alignItems: "center" }}>
            {node}
            {i < STEPS.length - 1 && (
              <span style={{ color: PAL.textMuted, margin: "0 2px" }} aria-hidden>
                ›
              </span>
            )}
          </span>
        );
      })}

      {runName && (
        <span
          style={{
            marginLeft: "auto",
            color: PAL.textDim,
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 280,
          }}
          title={`Working run: ${runName}`}
        >
          Working run: <strong style={{ color: PAL.text }}>{runName}</strong>
        </span>
      )}
    </div>
  );
}
