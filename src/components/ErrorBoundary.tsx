import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props { children: ReactNode; appName?: string; }
interface State { hasError: boolean; error: Error | null; }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.appName ?? "App"}] Crash:`, error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    const S = {
      wrap: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "#0F172A", color: "#F1F5F9", fontFamily: "'DM Sans', system-ui, sans-serif" } as const,
      card: { background: "#1E293B", borderRadius: 12, padding: "40px 48px", maxWidth: 520, textAlign: "center" as const, border: "1px solid #334155" },
      icon: { fontSize: 48, marginBottom: 16 },
      title: { fontSize: 20, fontWeight: 700, marginBottom: 8 },
      msg: { color: "#94A3B8", fontSize: 14, lineHeight: 1.6, marginBottom: 24 },
      code: { background: "#0F172A", border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", fontSize: 12, color: "#F87171", fontFamily: "monospace", textAlign: "left" as const, maxHeight: 120, overflow: "auto", marginBottom: 24, wordBreak: "break-word" as const },
      btn: { background: "#3B82F6", color: "#fff", border: "none", borderRadius: 8, padding: "10px 24px", fontSize: 14, fontWeight: 600, cursor: "pointer" },
    };

    return (
      <div style={S.wrap}>
        <div style={S.card}>
          <div style={S.icon}>⚠️</div>
          <div style={S.title}>Something went wrong</div>
          <div style={S.msg}>
            {this.props.appName ?? "The app"} ran into an unexpected error. Your data is safe — click below to reload.
          </div>
          {this.state.error && (
            <div style={S.code}>{this.state.error.message}</div>
          )}
          <button style={S.btn} onClick={() => window.location.reload()}>
            Reload App
          </button>
        </div>
      </div>
    );
  }
}
