import { ModelQuota } from '../types';

/**
 * Formats a remaining reset time ISO string into a concise user countdown:
 * e.g. "Ready", "3h 15m", "6d 21h", "45m"
 */
export function formatCountdown(isoString: string): string {
  try {
    const target = new Date(isoString).getTime();
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
    return 'Soon';
  }
}

/**
 * Parses countdown time from Google's native quota bucket description:
 * Matches Antigravity IDE workbench behavior (Vqo function reading description directly).
 * e.g. "You have used some of your weekly limit, it will fully refresh in 6 days, 15 hours." -> "6d 15h"
 * e.g. "it will fully refresh in 3 days, 22 hours." -> "3d 22h"
 * e.g. "it will fully refresh in 1 hour, 42 minutes." -> "1h 42m"
 * e.g. "fully refresh in 25 minutes." -> "25m"
 */
export function parseCountdownFromDescription(desc?: string): string | undefined {
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
}

/**
 * Synthesizes a future ISO date string from description duration if resetTime is missing or invalid.
 */
export function synthesizeResetTimeFromDescription(desc?: string): string | undefined {
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

  const totalMs = (days * 24 * 60 + hours * 60 + mins) * 60 * 1000;
  if (totalMs <= 0) return undefined;

  return new Date(Date.now() + totalMs).toISOString();
}

/**
 * Formats model display names to match the Antigravity IDE model picker exactly:
 * Gemini 3.8 / 3.7 / 3.6 / 3.1 Flash, Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B.
 */
export function formatModelDisplayName(id: string, apiDisplayName?: string): string {
  const lower = id.toLowerCase();

  // 1. Claude Sonnet
  if (lower.includes('claude-sonnet-4-6') || lower.includes('sonnet-4-6') || lower.includes('claude-3-7-sonnet') || lower.includes('claude-3.7-sonnet')) {
    return 'Claude Sonnet 4.6';
  }
  if (lower.includes('claude-3-5-sonnet') || lower.includes('claude-3.5-sonnet')) {
    return 'Claude Sonnet 3.5';
  }
  if (lower.includes('claude-sonnet')) return 'Claude Sonnet 4.6';

  // 2. Claude Opus
  if (lower.includes('claude-opus-4-6') || lower.includes('opus-4-6') || lower.includes('claude-3-opus') || lower.includes('claude-3.7-opus')) {
    return 'Claude Opus 4.6';
  }
  if (lower.includes('claude-opus')) return 'Claude Opus 4.6';

  // 3. GPT-OSS
  if (lower.includes('gpt-oss') || lower.includes('gpt_oss')) {
    return 'GPT-OSS 120B';
  }

  // 4. Gemini models — extract version number from ID (e.g. gemini-3.8-flash → Gemini 3.8 Flash)
  const verMatch = id.match(/gemini-(\d+(?:\.\d+)?)-([a-z]+)/i);
  if (verMatch) {
    const version = verMatch[1];
    const type = verMatch[2].charAt(0).toUpperCase() + verMatch[2].slice(1).toLowerCase();
    return `Gemini ${version} ${type}`;
  }

  if (apiDisplayName && !apiDisplayName.toLowerCase().includes('thinking')) {
    return apiDisplayName;
  }

  return id
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/Gpt Oss/i, 'GPT-OSS');
}

/**
 * Normalizes model ID key to prevent duplicate tiers (e.g. high/low variations)
 */
export function normalizeModelKey(id: string): string {
  return id
    .toLowerCase()
    .replace(/-high|-medium|-low|-tiered|-extra-low/g, '');
}

/**
 * Enforces a fixed, deterministic order matching Antigravity IDE standard model picker:
 * 1. Gemini Flash models (highest version first)
 * 2. Claude models (highest version first)
 * 3. GPT models
 */
export function sortModelQuotas(quotas: ModelQuota[]): ModelQuota[] {
  const extractVersion = (s: string): number => {
    const match = s.match(/(\d+(?:\.\d+)?)/);
    return match ? parseFloat(match[1]) : 0;
  };

  const getRank = (q: ModelQuota): number => {
    const s = (q.id + ' ' + (q.displayName || '')).toLowerCase();
    const isGemini = s.includes('gemini') || s.includes('flash');
    const isClaude = s.includes('claude') || s.includes('opus') || s.includes('sonnet') || s.includes('haiku');
    const isGpt = s.includes('gpt');

    const ver = extractVersion(s);

    if (isGemini) {
      const typeBonus = s.includes('pro') ? 0.05 : 0;
      return 1000 - (ver * 100 + typeBonus);
    }

    if (isClaude) {
      const typeBonus = s.includes('opus') ? 0.1 : s.includes('sonnet') ? 0.05 : 0;
      return 2000 - (ver * 100 + typeBonus);
    }

    if (isGpt) {
      return 3000 - ver;
    }

    return 4000;
  };

  return [...quotas].sort((a, b) => {
    const rankA = getRank(a);
    const rankB = getRank(b);
    if (rankA !== rankB) return rankA - rankB;
    return (a.displayName || a.id).localeCompare(b.displayName || b.id);
  });
}

/**
 * Extracts normalized quota remaining fraction (0.0 to 1.0) from various Google API formats.
 */
export function extractFraction(data: any): number {
  if (!data) return 0.0;
  const q = data.quotaInfo || data.quota || data.userQuota || data;
  if (!q) return 0.0;

  // Direct fraction numbers
  if (typeof q.remainingFraction === 'number') return Math.max(0, Math.min(1, q.remainingFraction));
  if (typeof data.remainingFraction === 'number') return Math.max(0, Math.min(1, data.remainingFraction));
  if (typeof q.fraction === 'number') return Math.max(0, Math.min(1, q.fraction));
  if (typeof data.fraction === 'number') return Math.max(0, Math.min(1, data.fraction));
  if (typeof q.remainingQuota === 'number') return Math.max(0, Math.min(1, q.remainingQuota));

  // Nested remaining object (proto3 oneof or wrapped value)
  if (q.remaining && typeof q.remaining === 'object') {
    if (typeof q.remaining.value === 'number') return Math.max(0, Math.min(1, q.remaining.value));
    if (typeof q.remaining.remainingFraction === 'number') return Math.max(0, Math.min(1, q.remaining.remainingFraction));
    if (typeof q.remaining.fraction === 'number') return Math.max(0, Math.min(1, q.remaining.fraction));
  }
  if (data.remaining && typeof data.remaining === 'object') {
    if (typeof data.remaining.value === 'number') return Math.max(0, Math.min(1, data.remaining.value));
    if (typeof data.remaining.remainingFraction === 'number') return Math.max(0, Math.min(1, data.remaining.remainingFraction));
    if (typeof data.remaining.fraction === 'number') return Math.max(0, Math.min(1, data.remaining.fraction));
  }

  if (typeof q.remaining === 'number') return Math.max(0, Math.min(1, q.remaining));

  // Percentage values (0-100)
  if (typeof q.remainingPercentage === 'number') return Math.max(0, Math.min(1, q.remainingPercentage / 100));
  if (typeof q.percentage === 'number') return Math.max(0, Math.min(1, q.percentage / 100));

  // Used / consumed fraction inversion
  if (typeof q.usedFraction === 'number') return Math.max(0, Math.min(1, 1 - q.usedFraction));
  if (typeof q.consumedFraction === 'number') return Math.max(0, Math.min(1, 1 - q.consumedFraction));
  if (typeof data.usedFraction === 'number') return Math.max(0, Math.min(1, 1 - data.usedFraction));

  // In proto3 JSON serialization, default float 0.0 is omitted!
  // Therefore, if quotaInfo or resetTime is present but remainingFraction is missing,
  // the quota has been completely depleted (0% remaining).
  if (data.quotaInfo || q.resetTime || data.resetTime) {
    return 0.0;
  }

  return 0.0;
}
