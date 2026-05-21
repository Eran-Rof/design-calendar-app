// Shared date picker — same custom-popover calendar implementation
// across every app in the workspace. Built on top of tanda's
// MilestoneDateInput (the first custom date picker in the codebase)
// so the UX + colors stay consistent without duplicating logic. New
// consumers should import { AppDatePicker } from "@/shared/components/
// AppDatePicker" instead of the tanda-internal name.
//
// All apps share the dark slate theme defined inside the picker — no
// native <input type="date"> browser-rendered widgets anywhere in the
// app so platform/Chromium/Safari styling drift can't surface.

import React from "react";
import { MilestoneDateInput } from "../../tanda/detail/MilestoneDateInput";

export interface AppDatePickerProps {
  value: string;                          // ISO yyyy-mm-dd
  onCommit: (v: string) => void;          // empty string = cleared
  style?: React.CSSProperties;
}

export const AppDatePicker: React.FC<AppDatePickerProps> = (props) => (
  <MilestoneDateInput {...props} />
);
