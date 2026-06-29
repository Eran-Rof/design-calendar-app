// "← PLM" navigation for the ATS app.
//
// Re-exports the shared helper (src/shared/backToPlm.ts) so there's a single
// implementation. ATS shipped this behaviour first (#1200); it was promoted to
// a shared module when every other app got it via the NavDrawer footer. ATS has
// no NavDrawer, so its own NavBar imports backToPlmHome from here.
export { backToPlmHome } from "../shared/backToPlm";
