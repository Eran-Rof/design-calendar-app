import React, { useState, useRef, useEffect } from "react";
import { TH } from "../utils/theme";

function SettingsDropdown({
  isAdmin,
  onTeam,
  onVendors,
  onSizes,
  onCategories,
  onUsers,
  onBrands,
  onSeasons,
  onCustomers,
  onPOTypes,
  onRoles,
  onTasks,
  onGenders,
}: {
  isAdmin: boolean;
  onTeam: () => void;
  onVendors: () => void;
  onSizes: () => void;
  onCategories: () => void;
  onUsers: () => void;
  onBrands: () => void;
  onSeasons: () => void;
  onCustomers: () => void;
  onPOTypes: () => void;
  onRoles: () => void;
  onTasks: () => void;
  onGenders: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);
  const items = [
    { icon: "👥", label: "Team", onClick: onTeam, always: true },
    { icon: "🏭", label: "Vendors", onClick: onVendors, always: true },
    { icon: "🏷️", label: "Brands", onClick: onBrands, always: false },
    { icon: "🌿", label: "Seasons", onClick: onSeasons, always: false },
    { icon: "🏪", label: "Customers", onClick: onCustomers, always: false },
    { icon: "📐", label: "Sizes", onClick: onSizes, always: false },
    { icon: "🗂️", label: "Categories", onClick: onCategories, always: false },
    { icon: "⚧", label: "Genders", onClick: onGenders, always: false },
    { icon: "📋", label: "Order Types", onClick: onPOTypes, always: false },
    { icon: "📋", label: "Tasks", onClick: onTasks, always: false },
    { icon: "🎭", label: "Roles", onClick: onRoles, always: false },
    { icon: "👤", label: "Users", onClick: onUsers, always: false },
  ].filter((it) => it.always || isAdmin);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: "7px 13px",
          borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.15)",
          background: open ? "rgba(255,255,255,0.1)" : "none",
          color: "rgba(255,255,255,0.8)",
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        ⚙️ Settings
        <span style={{ fontSize: 9, opacity: 0.6 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            background: "#1A202C",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 10,
            boxShadow: "0 8px 32px rgba(0,0,0,0.45)",
            minWidth: 170,
            zIndex: 999,
            overflow: "hidden",
          }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              onClick={() => {
                it.onClick();
                setOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "11px 16px",
                border: "none",
                background: "none",
                color: "rgba(255,255,255,0.8)",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: 500,
                textAlign: "left",
                borderBottom: "1px solid rgba(255,255,255,0.06)",
              }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.08)")
              }
              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "none")}
            >
              <span>{it.icon}</span>
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default SettingsDropdown;
