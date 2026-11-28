/** USD for display: 2 significant digits under $0.01 ("$0.00012"), 4 decimals up to $1 ("$0.0123"), then 2 decimals ("$12.34"). */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value < 0.01) return `$${Number(value.toPrecision(2)).toFixed(Math.min(20, Math.max(2, 1 - Math.floor(Math.log10(value)))))}`;
  return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** The exact amount for a tooltip: "$0.000123456". */
export function formatUsdFull(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  return `$${value.toFixed(value < 0.01 ? 9 : 6).replace(/0+$/, "").replace(/\.$/, "")}`;
}
