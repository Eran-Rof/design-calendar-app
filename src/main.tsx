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
    const { default: TechPack } = await import("./TechPack");
    root.render(<StrictMode><TechPack /></StrictMode>);
  } else if (path.startsWith("/ats")) {
    const { default: ATS } = await import("./ATS");
    root.render(<StrictMode><ATS /></StrictMode>);
  } else {
    // Root "/" — PLM Launcher
    const { default: PLMApp } = await import("./PLM");
    root.render(<StrictMode><PLMApp /></StrictMode>);
  }
}

mount();
