/**
 * Shared quota → colour mapping so every progress bar / percentage label
 * reflects its own value consistently (green > 50%, amber > 20%, red otherwise).
 */
export const quotaFillClass = (p: number): string => {
  if (p > 50) return 'bg-emerald-500';
  if (p > 20) return 'bg-amber-500';
  return 'bg-rose-500';
};

export const quotaTextClass = (p: number): string => {
  if (p > 50) return 'text-emerald-400';
  if (p > 20) return 'text-amber-400';
  return 'text-rose-400';
};

export const quotaStrokeColor = (p: number): string => {
  if (p > 50) return '#10b981';
  if (p > 20) return '#f59e0b';
  return '#ef4444';
};
