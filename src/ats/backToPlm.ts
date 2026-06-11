// "← PLM" navigation for the ATS app.
//
// This now re-exports the shared cross-app helper (src/shared/backToPlm.ts) so
// there is a single source of truth — ATS shipped this behaviour first (#1200)
// and it was promoted to a shared module when the other apps adopted it. Kept as
// a thin re-export so existing ATS imports of "./backToPlm" keep working.
export { backToPlmHome } from "../shared/backToPlm";
