// Back-compat re-export. The actual implementation lives at
// src/shared/components/AppDatePicker.tsx now (moved 2026-05-21
// to make shared/ canonical). Existing tanda callers can keep
// importing `MilestoneDateInput` from this path; new code in
// any app should import `AppDatePicker` directly from the
// shared module.

export { AppDatePicker as MilestoneDateInput } from "../../shared/components/AppDatePicker";
