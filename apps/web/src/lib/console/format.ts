const usdFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

/**
 * USD currency formatter for cost values across Console. Plain module (no
 * "use client") so it can be called from both server and client
 * components — moved out of ConsoleUsageCharts.tsx, which is a "use
 * client" module, because ConsoleDashboardClient.tsx (a server component)
 * needs to call it directly in JSX, not just render it as a component.
 */
export function formatUsd(n: number): string {
  return usdFormatter.format(n);
}
