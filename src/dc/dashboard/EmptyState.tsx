// Empty state shown when the user has no tasks at all. Admin sees a
// "+ New Collection" CTA; non-admins see just the message. Extracted
// from DashboardPanel so the panel's main render is shorter.

import { S, TH } from "../styles";

export interface EmptyStateProps {
  isAdmin: boolean;
  onCreateCollection: () => void;
}

export function EmptyState({ isAdmin, onCreateCollection }: EmptyStateProps) {
  return (
    <div style={{ textAlign: "center", padding: "80px 0" }}>
      <div style={{ fontSize: 52, marginBottom: 16 }}>📅</div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 800,
          color: TH.text,
          marginBottom: 8,
        }}
      >
        No collections yet
      </div>
      <div style={{ fontSize: 14, color: TH.textMuted, marginBottom: 28 }}>
        Create your first collection to auto-generate a full timeline.
      </div>
      {isAdmin && (
        <button
          onClick={onCreateCollection}
          style={{ ...S.btn, padding: "14px 32px", fontSize: 15 }}
        >
          + New Collection
        </button>
      )}
    </div>
  );
}
