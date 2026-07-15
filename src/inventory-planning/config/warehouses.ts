// Warehouse sets per planning channel.
//
// Single source of truth for on-hand (docs/tangerine/onhand-single-source-of-truth.md):
// planning reads the Xoro REST by-size on-hand (re-sourced as source='tangerine',
// PR #1786) and each channel sums ONLY its own warehouses, so a wholesale run
// never counts ecom stock and vice-versa. The exact strings match the
// warehouse_code values the Xoro pull writes into tangerine_size_onhand.

export const WHOLESALE_WAREHOUSES: readonly string[] = ["ROF Main", "Psycho Tuna"];
export const ECOM_WAREHOUSES: readonly string[] = ["ROF - ECOM", "Psycho Tuna Ecom"];
