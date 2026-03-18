import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Simple path-based routing — no router library needed
const path = window.location.pathname;

async function mount() {
  const root = createRoot(document.getElementById("root")!);

  if (path.startsWith("/design")) {
    const { default: App } = await import("./App");
    root.render(<StrictMode><App /></StrictMode>);
  } else if (path.startsWith("/tanda")) {
    const { default: TandA } = await import("./TandA");
    root.render(<StrictMode><TandA /></StrictMode>);
  } else if (path.startsWith("/techpack")) {
    root.render(
      <StrictMode>
        <TechPackPlaceholder />
      </StrictMode>
    );
  } else {
    // Root "/" — PLM Launcher
    const { default: PLMApp } = await import("./PLM");
    root.render(<StrictMode><PLMApp /></StrictMode>);
  }
}

function TechPackPlaceholder() {
  return (
    <div style={{ minHeight: "100vh", background: "#F9FAFB", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans','Segoe UI',sans-serif" }}>
      <div style={{ fontSize: 64, marginBottom: 16 }}>📐</div>
      <h1 style={{ color: "#111827", fontSize: 28, fontWeight: 700, margin: "0 0 8px" }}>Tech Packs</h1>
      <p style={{ color: "#6B7280", fontSize: 16, margin: "0 0 32px" }}>Coming soon — this module is under development</p>
      <a href="/" style={{ background: "#CC2200", color: "#fff", padding: "12px 24px", borderRadius: 8, textDecoration: "none", fontWeight: 600, fontSize: 14 }}>
        ← Back to Launcher
      </a>
    </div>
  );
}

mount();
