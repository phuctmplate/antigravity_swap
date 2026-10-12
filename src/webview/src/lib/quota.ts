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

export const MODEL_WEIGHTS = {
  GEMINI: 0.85,
  CLAUDE: 0.15,
} as const;

/**
 * Calculates the usable instant burst quota for a rolling window (5h)
 * modulated by remaining weekly fuel capacity.
 * - Above 30% weekly: rolling window is 100% usable (HealthFactor = 1.0).
 * - Below 30% weekly: weekly fuel attenuates 5h via smooth linear decay (Weekly / 30).
 */
export const calculateModulatedInstantQuota = (p5h: number, pWeekly?: number): number => {
  if (pWeekly === undefined) {
    return p5h;
  }
  const SAFE_WEEKLY_THRESHOLD = 30;
  const healthFactor =
    pWeekly >= SAFE_WEEKLY_THRESHOLD
      ? 1.0
      : Math.max(0, pWeekly) / SAFE_WEEKLY_THRESHOLD;
  return Math.round(p5h * healthFactor);
};

export const formatCountdown = (isoString?: string): string | undefined => {
  if (!isoString) return undefined;
  try {
    const target = new Date(isoString).getTime();
    if (isNaN(target)) return undefined;
    const diff = target - Date.now();
    if (diff <= 0) return 'Ready';
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 24) {
      const days = Math.floor(hours / 24);
      const remHours = hours % 24;
      return `${days}d ${remHours}h`;
    }
    if (hours > 0) {
      return `${hours}h ${mins}m`;
    }
    return `${mins}m`;
  } catch {
    return undefined;
  }
};
