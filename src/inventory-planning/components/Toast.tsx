// Re-export shim. The Toast implementation moved to
// src/shared/ui/Toast.tsx so ATS, tanda (PO WIP), and planning all
// share one component. This file is preserved so existing
// "../components/Toast" import paths in the planning module keep
// working without a sweeping import-path change.

export { default } from "../../shared/ui/Toast";
export type { ToastKind, ToastMessage, ToastProps } from "../../shared/ui/Toast";
