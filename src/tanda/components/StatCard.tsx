import React from "react";
import S from "../styles";

interface StatCardProps {
  label: string;
  value: string | number;
  color: string;
  icon: string;
  onClick?: () => void;
}

export const StatCard: React.FC<StatCardProps> = ({ label, value, color, icon, onClick }) => (
  <div
    style={{ ...S.statCard, borderTop: `3px solid ${color}`, cursor: onClick ? "pointer" : "default", transition: "transform 0.15s, box-shadow 0.15s" }}
    onClick={onClick}
    onMouseEnter={e => { if (onClick) { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.3)"; } }}
    onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; }}
  >
    <div style={{ fontSize: 24 }}>{icon}</div>
    <div style={{ fontSize: 28, fontWeight: 700, color, fontFamily: "monospace" }}>{value}</div>
    <div style={{ color: "#9CA3AF", fontSize: 13 }}>{label}</div>
  </div>
);
