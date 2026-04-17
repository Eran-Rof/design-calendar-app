import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";

interface Props { children: ReactNode; }
interface State { error: Error | null; }

export class GridErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[GridErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: "40px 32px", textAlign: "center", color: "#F87171",
          background: "#0F172A", border: "1px solid #3D1515", borderRadius: 8, margin: 24,
        }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
            Something went wrong rendering the inventory grid.
          </div>
          <div style={{ fontSize: 12, color: "#94A3B8", fontFamily: "monospace", marginBottom: 20 }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              background: "#1D4ED8", border: "none", color: "#fff",
              borderRadius: 6, padding: "8px 20px", fontSize: 13,
              fontWeight: 600, cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
