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
 * Safe Weekly Quota Thresholds (%) for Instant Quota Modulation
 * Defines the minimum weekly quota percentage needed so that an account
 * can burn 100% of its 5-hour rolling burst window without hitting the weekly limit.
 * - Gemini: ~22.86% measured (set to 25% with safe buffer, ~4.38 burst sessions/week)
 * - Claude & GPT: 50% measured (burning 100% 5h depletes 50% weekly, ~2 burst sessions/week)
 */
export const SAFE_WEEKLY_THRESHOLDS = {
  GEMINI: 25,
  CLAUDE_GPT: 50,
  DEFAULT: 25,
} as const;

/**
 * Calculates the usable instant burst quota for a rolling window (5h)
 * modulated by remaining weekly fuel capacity.
 * - Above safe threshold (25% for Gemini, 50% for Claude & GPT): rolling window is 100% usable (HealthFactor = 1.0).
 * - Below safe threshold: weekly fuel attenuates 5h via smooth linear decay (Weekly / threshold).
 */
export const calculateModulatedInstantQuota = (
  p5h: number,
  pWeekly?: number,
  safeWeeklyThreshold: number = SAFE_WEEKLY_THRESHOLDS.DEFAULT
): number => {
  if (pWeekly === undefined) {
    return p5h;
  }
  const healthFactor =
    pWeekly >= safeWeeklyThreshold
      ? 1.0
      : Math.max(0, pWeekly) / safeWeeklyThreshold;
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
    if (hours >= 24) {
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

/**
 * Parses countdown time from Google's native quota bucket description:
 * e.g. "You have used some of your weekly limit, it will fully refresh in 6 days, 15 hours." -> "6d 15h"
 */
export const parseCountdownFromDescription = (desc?: string): string | undefined => {
  if (!desc || typeof desc !== 'string') return undefined;

  const match = desc.match(/(?:fully refresh in|refreshes in|refresh in|resets in)\s+([^.]+)/i);
  if (!match) return undefined;

  const raw = match[1].trim();
  const daysMatch = raw.match(/(\d+)\s*(?:days?|d)\b/i);
  const hoursMatch = raw.match(/(\d+)\s*(?:hours?|hrs?|h)\b/i);
  const minsMatch = raw.match(/(\d+)\s*(?:minutes?|mins?|m)\b/i);

  const days = daysMatch ? parseInt(daysMatch[1], 10) : 0;
  const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
  const mins = minsMatch ? parseInt(minsMatch[1], 10) : 0;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  if (mins > 0) {
    return `${mins}m`;
  }

  return raw;
};

