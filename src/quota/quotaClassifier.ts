import { AccountTierType, QuotaWindowType, AccountInfo } from '../types';

/**
 * Robustly identifies whether a quota bucket represents a 5-hour rolling window.
 */
export function is5HourBucket(windowStr?: string, bucketId?: string, displayName?: string): boolean {
  const w = (windowStr || '').toLowerCase();
  const id = (bucketId || '').toLowerCase();
  const name = (displayName || '').toLowerCase();
  return (
    w === '5h' ||
    w.includes('5h') ||
    w.includes('5_hour') ||
    w.includes('5-hour') ||
    w.includes('5 hour') ||
    w.includes('five') ||
    id.includes('5h') ||
    id.includes('5-hour') ||
    id.includes('5_hour') ||
    id.includes('five') ||
    name.includes('5-hour') ||
    name.includes('5 hour') ||
    name.includes('five hour') ||
    name.includes('5h') ||
    name.includes('rolling')
  );
}

/**
 * Robustly identifies whether a quota bucket represents a weekly plan quota.
 */
export function isWeeklyBucket(windowStr?: string, bucketId?: string, displayName?: string): boolean {
  const w = (windowStr || '').toLowerCase();
  const id = (bucketId || '').toLowerCase();
  const name = (displayName || '').toLowerCase();
  return (
    w === 'weekly' ||
    w.includes('weekly') ||
    w.includes('7d') ||
    id.includes('weekly') ||
    id.includes('plan') ||
    name.includes('weekly') ||
    name.includes('plan')
  );
}

export const MAX_5H_WINDOW_MS = 5.5 * 60 * 60 * 1000;

/**
 * Checks whether a reset timestamp falls within the physical boundary of a 5-hour rolling window
 * (must be at most 5.5 hours into the future, rejecting weekly/plan cycles that reset days away).
 */
export function isResetTimeWithin5Hours(resetTime?: string): boolean {
  if (!resetTime) return false;
  try {
    const diff = new Date(resetTime).getTime() - Date.now();
    return diff <= MAX_5H_WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * Checks whether a reset timestamp is beyond 5.5 hours in the future
 * (guaranteed to be a weekly/plan quota cycle, never a 5h rolling limit).
 */
export function isResetTimeBeyond5Hours(resetTime?: string): boolean {
  if (!resetTime) return false;
  try {
    const diff = new Date(resetTime).getTime() - Date.now();
    return diff > MAX_5H_WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * Classifies a model quota into 5h rolling window vs weekly plan quota.
 * 
 * Physical limit boundary: a genuine 5-hour rolling limit CANNOT physically have a future reset time > 5.5 hours away.
 * Conversely, if resetTime is <= 5.5 hours away, it could EITHER be a 5-hour rolling window OR a weekly cycle near its end (e.g. 4h, 1h, 10m left).
 * To prevent misclassification, we resolve ambiguity using:
 * 1. Explicit bucket/name keywords
 * 2. Account tier (Free accounts have NO 5h window)
 * 3. Model family (Claude & GPT 3P models are bound to weekly pools)
 * 4. Cross-referencing against known group weekly and 5h reset times
 * 5. Model tier characteristics (Pro/Ultra default to weekly, Flash defaults to 5h)
 */
export function classifyQuotaWindow(
  id: string,
  displayName: string,
  resetTime?: string,
  description?: string,
  knownWeeklyResetTime?: string,
  known5HourResetTime?: string,
  isFreeAccount?: boolean
): { windowType: QuotaWindowType; windowLabel: string } {
  const idLower = (id + ' ' + displayName + ' ' + (description || '')).toLowerCase();

  // 1. Explicit Weekly matching: If description/name explicitly mentions 'weekly' or 'plan', it is Weekly!
  if (idLower.includes('weekly') || idLower.includes('plan')) {
    return { windowType: 'weekly', windowLabel: 'Weekly Plan Quota' };
  }

  // 2. Explicit 5h keywords
  if (idLower.includes('5h') || idLower.includes('5-hour') || idLower.includes('rolling')) {
    return { windowType: '5h', windowLabel: '5-Hour Rolling Window' };
  }

  // 3. Free tier accounts: Free tier in Google Antigravity NEVER has a 5-hour rolling window.
  // All quotas on free accounts belong to the weekly bucket.
  if (isFreeAccount) {
    return { windowType: 'weekly', windowLabel: 'Weekly Plan Quota' };
  }

  // 4. Claude and GPT models: In Antigravity paid accounts, Claude & GPT 3P models have both 5h rolling and weekly pools.
  const isClaudeOrGpt = idLower.includes('claude') || idLower.includes('opus') || idLower.includes('sonnet') || idLower.includes('gpt');
  if (isClaudeOrGpt) {
    if (resetTime && isResetTimeWithin5Hours(resetTime) && (!knownWeeklyResetTime || resetTime !== knownWeeklyResetTime)) {
      return { windowType: '5h', windowLabel: '5-Hour Rolling Window' };
    }
    return { windowType: 'weekly', windowLabel: 'Weekly Plan Quota' };
  }

  // 5. Model Tier / Family Classification (MUST precede cross-reference):
  // Google returns the SAME resetTime for all Gemini models (both Flash and Pro), so we cannot
  // rely solely on resetTime cross-reference to distinguish them. Pro/Ultra model identity is
  // the strongest unambiguous signal — always weekly regardless of resetTime.
  const isProModel = /\bpro\b|[-_.]pro\b|\bpro[-_.]/i.test(idLower);
  const isUltraModel = /\bultra\b|[-_.]ultra\b/i.test(idLower);

  if (isProModel || isUltraModel) {
    return { windowType: 'weekly', windowLabel: 'Weekly Plan Quota' };
  }

  // 6. Direct Cross-Reference with known Quota Group Reset Times:
  // Even if the weekly cycle is in its final hours (e.g. 4h, 1h, 10m remaining),
  // if the model's resetTime matches the group's weekly reset time, it is unambiguously a Weekly Plan Quota.
  if (resetTime && (knownWeeklyResetTime || known5HourResetTime)) {
    try {
      const modelMs = new Date(resetTime).getTime();
      const weeklyMs = knownWeeklyResetTime ? new Date(knownWeeklyResetTime).getTime() : NaN;
      const fiveHourMs = known5HourResetTime ? new Date(known5HourResetTime).getTime() : NaN;

      const matchesWeekly = !isNaN(weeklyMs) && Math.abs(modelMs - weeklyMs) <= 5 * 60 * 1000;
      const matches5h = !isNaN(fiveHourMs) && Math.abs(modelMs - fiveHourMs) <= 5 * 60 * 1000;

      if (matchesWeekly && !matches5h) {
        return { windowType: 'weekly', windowLabel: 'Weekly Plan Quota' };
      }
      if (matches5h && !matchesWeekly) {
        return { windowType: '5h', windowLabel: '5-Hour Rolling Window' };
      }
      // Both match: use model name to disambiguate (flash = 5h, others = weekly)
      if (matchesWeekly && matches5h) {
        const isFlash = idLower.includes('flash');
        return isFlash
          ? { windowType: '5h', windowLabel: '5-Hour Rolling Window' }
          : { windowType: 'weekly', windowLabel: 'Weekly Plan Quota' };
      }
    } catch {}
  }

  // 7. Physical Limit Boundary Check:
  // A 5-hour rolling limit window CANNOT physically have a future reset time > 5.5 hours away.
  // If resetTime is > 5.5 hours away, it is mathematically guaranteed to belong to a weekly (or longer) cycle.
  if (resetTime && isResetTimeBeyond5Hours(resetTime)) {
    return { windowType: 'weekly', windowLabel: 'Weekly Plan Quota' };
  }

  // 8. Flash and lightweight models default to 5-Hour Rolling Window
  return { windowType: '5h', windowLabel: '5-Hour Rolling Window' };
}

export function mapBadgeToResult(tier: AccountTierType): { accountType: string; tierBadge: AccountTierType } {
  switch (tier) {
    case 'ENTERPRISE':
      return { accountType: 'Antigravity Enterprise', tierBadge: 'ENTERPRISE' };
    case 'ULTRA':
      return { accountType: 'Google AI Ultra', tierBadge: 'ULTRA' };
    case 'AI PREMIUM':
      return { accountType: 'Google AI Premium', tierBadge: 'AI PREMIUM' };
    case 'PRO':
      return { accountType: 'Google AI Pro', tierBadge: 'PRO' };
    case 'STANDARD FREE':
    default:
      return { accountType: 'Standard Free', tierBadge: 'STANDARD FREE' };
  }
}

/**
 * Determines account subscription tier strictly based on Google account subscription data.
 * Standard free accounts will always receive 'STANDARD FREE' without Pro badge.
 */
export function determineAccountTier(
  rawResponse: any,
  account?: AccountInfo
): { accountType: string; tierBadge: AccountTierType } {
  if (!rawResponse) {
    return {
      accountType: account?.accountType || 'Standard Free',
      tierBadge: account?.tierBadge || 'STANDARD FREE'
    };
  }

  const checkStringForPaidTier = (val: string): AccountTierType | null => {
    if (!val || typeof val !== 'string') return null;
    const s = val.toLowerCase();
    if (s.includes('enterprise') || s.includes('corporate') || s.includes('workspace_enterprise')) return 'ENTERPRISE';
    if (s.includes('ultra') || s.includes('gemini_ultra') || s.includes('ai_ultra') || s.includes('g1-ultra')) return 'ULTRA';
    if (s.includes('ai_premium') || s.includes('ai premium') || s.includes('gemini advanced') || s.includes('google_one_premium') || s.includes('g1-premium')) return 'AI PREMIUM';
    if (s.includes('user_tier_pro') || s.includes('tier_pro') || s.includes('google_one_pro') || s.includes('pro_tier') || s.includes('g1-pro') || s.includes('google ai pro') || /\bpro\b/.test(s)) {
      return 'PRO';
    }
    return null;
  };

  // In Google Cloud Code PA, ONLY paid Google AI accounts (Pro/Ultra) receive 5-hour rolling limit buckets ("Five Hour Limit Remaining" / window: "5h").
  // Standard Free accounts ONLY have Weekly Limit Remaining.
  const groups = rawResponse?.response?.groups || rawResponse?.groups || [];
  const has5hBucket = groups.some((g: any) =>
    (g.buckets || []).some((b: any) => {
      return is5HourBucket(b.window, b.bucketId, b.displayName);
    })
  );

  const hasClaudeOrGpt = groups.some((g: any) => {
    const title = (g.displayName || '').toLowerCase();
    return title.includes('claude') || title.includes('gpt');
  });

  // 1. Check paidTier FIRST (This is Google's canonical field for paid Google AI / Google One subscriptions)
  if (rawResponse.paidTier) {
    if (typeof rawResponse.paidTier === 'object') {
      const id = (rawResponse.paidTier.id || '').toLowerCase();
      const name = (rawResponse.paidTier.name || '').toLowerCase();
      const desc = (rawResponse.paidTier.description || '').toLowerCase();
      const combined = `${id} ${name} ${desc}`;

      // If paidTier is explicitly free-tier / starter quota:
      if (id === 'free-tier' || id.includes('free') || name.includes('starter') || combined.includes('starter quota')) {
        // If retrieveUserQuotaSummary returned an authentic 5-hour rolling bucket, it is incontrovertibly a paid tier
        if (has5hBucket) {
          return { accountType: 'Google AI Pro', tierBadge: 'PRO' };
        }
        return { accountType: 'Standard Free', tierBadge: 'STANDARD FREE' };
      }

      const t = checkStringForPaidTier(combined);
      if (t) return mapBadgeToResult(t);
    } else if (typeof rawResponse.paidTier === 'string') {
      if (rawResponse.paidTier.toLowerCase().includes('free') || rawResponse.paidTier.toLowerCase().includes('starter')) {
        if (has5hBucket) {
          return { accountType: 'Google AI Pro', tierBadge: 'PRO' };
        }
        return { accountType: 'Standard Free', tierBadge: 'STANDARD FREE' };
      }
      const t = checkStringForPaidTier(rawResponse.paidTier);
      if (t) return mapBadgeToResult(t);
    }
  }

  // 2. Check userTier (Antigravity's internal user subscription tier)
  if (rawResponse.userTier) {
    if (typeof rawResponse.userTier === 'object') {
      const combined = `${rawResponse.userTier.id || ''} ${rawResponse.userTier.name || ''} ${rawResponse.userTier.description || ''}`;
      const t = checkStringForPaidTier(combined);
      if (t) return mapBadgeToResult(t);
    } else if (typeof rawResponse.userTier === 'string') {
      const t = checkStringForPaidTier(rawResponse.userTier);
      if (t) return mapBadgeToResult(t);
    }
  }

  // 3. Check explicit plan / subscription fields
  const planObj =
    rawResponse.plan ||
    rawResponse.subscription ||
    rawResponse.userSubscription ||
    rawResponse.accountPlan ||
    rawResponse.planName ||
    rawResponse.teamsTier;
  if (planObj) {
    const s = typeof planObj === 'string' ? planObj : JSON.stringify(planObj);
    const t = checkStringForPaidTier(s);
    if (t) return mapBadgeToResult(t);
  }


  // 4. Check retrieveUserQuotaSummary buckets:
  if (has5hBucket) {
    return { accountType: 'Google AI Pro', tierBadge: 'PRO' };
  }

  // 5. Check if currentTier explicitly indicates a paid plan (excluding "free-tier" which is just the IDE client tier)
  if (rawResponse.currentTier) {
    if (typeof rawResponse.currentTier === 'object') {
      const id = (rawResponse.currentTier.id || '').toLowerCase();
      const name = (rawResponse.currentTier.name || '').toLowerCase();
      if (id !== 'free-tier' && !id.includes('free')) {
        const t = checkStringForPaidTier(`${id} ${name}`);
        if (t) return mapBadgeToResult(t);
      }
    } else if (typeof rawResponse.currentTier === 'string') {
      if (!rawResponse.currentTier.toLowerCase().includes('free')) {
        const t = checkStringForPaidTier(rawResponse.currentTier);
        if (t) return mapBadgeToResult(t);
      }
    }
  }

  // Preserve existing known paid tier if response didn't specify
  if (account?.tierBadge && account.tierBadge !== 'STANDARD FREE') {
    return {
      accountType: account.accountType || mapBadgeToResult(account.tierBadge).accountType,
      tierBadge: account.tierBadge
    };
  }

  return { accountType: 'Standard Free', tierBadge: 'STANDARD FREE' };
}
