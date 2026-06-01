/** Strip legacy import-source prefixes (EXCEL:, ATS:) from a customer code for display. Data is unchanged. */
export function displayCustomerCode(code: string | null | undefined): string {
  return String(code ?? "").replace(/^(EXCEL|ATS):/i, "");
}
