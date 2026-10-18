import {
  AccountInfo,
  AccountTierType,
  ModelQuota,
  OverallQuotaSummary
} from '../types';
import { TIER_WEIGHTS, MODEL_WEIGHTS, SAFE_WEEKLY_THRESHOLDS } from '../constants';

/**
 * Calculates the usable instant burst quota for a rolling window (5h)
 * modulated by remaining weekly fuel capacity.
 * - Above safe threshold (25% for Gemini, 50% for Claude & GPT): rolling window is 100% usable (HealthFactor = 1.0).
 * - Below safe threshold: weekly fuel attenuates 5h via smooth linear decay (Weekly / threshold).
 */
export function calculateModulatedInstantQuota(
  p5h: number,
  pWeekly?: number,
  safeWeeklyThreshold: number = SAFE_WEEKLY_THRESHOLDS.DEFAULT
): number {
  if (pWeekly === undefined) {
    return p5h;
  }
  const healthFactor =
    pWeekly >= safeWeeklyThreshold
      ? 1.0
      : Math.max(0, pWeekly) / safeWeeklyThreshold;
  return Math.round(p5h * healthFactor);
}

/**
 * Calculates average quota percentage across valid model quotas.
 * Excludes disabled models and -1 sentinel values.
 */
export function calculateAveragePercentage(quotas: ModelQuota[]): number {
  if (!quotas || quotas.length === 0) return 0;
  const valid = quotas.filter((q) => !q.disabled && q.percentage >= 0);
  if (valid.length === 0) return 0;
  const sum = valid.reduce((acc, q) => acc + q.percentage, 0);
  return Math.round(sum / valid.length);
}

/**
 * Finds the soonest upcoming reset time from a list of model quotas.
 */
export function findSoonestResetTime(quotas: ModelQuota[]): string | undefined {
  const valid = quotas.filter((q) => !!q.resetTime);
  if (valid.length === 0) return undefined;
  const now = Date.now();
  const future = valid
    .map((q) => ({ time: q.resetTime!, ms: new Date(q.resetTime!).getTime() }))
    .filter((item) => !isNaN(item.ms) && item.ms > now)
    .sort((a, b) => a.ms - b.ms);
  if (future.length > 0) {
    return future[0].time;
  }
  return valid[0].resetTime;
}

/**
 * Computes capacity-weighted overall aggregate percentage across all healthy accounts.
 * Accounts with higher tier allocations (Enterprise > Ultra > AI Premium > Pro > Free) contribute proportionately:
 * - Enterprise: 5.0x weight
 * - Ultra: 4.0x weight
 * - AI Premium: 3.0x weight
 * - Pro: 1.0x weight
 * - Free: 0.5x baseline weight (at 100% standard access) for overall; 0x weight for weekly & 5h windows.
 */
export function calculateOverallSummary(accounts: AccountInfo[]): OverallQuotaSummary {
  if (accounts.length === 0) {
    return {
      totalAccounts: 0,
      instantPercentage: 0,
      overallPercentage: 0,
      geminiInstantPercentage: 0,
      gemini5HourPercentage: undefined,
      geminiWeeklyPercentage: undefined,
      claudeInstantPercentage: 0,
      claude5HourPercentage: undefined,
      claudeWeeklyPercentage: undefined,
      overall5HourPercentage: 0,
      overallWeeklyPercentage: 0,
      averageActiveAccountPercentage: 0,
      highestAccountQuotaPercentage: 0,
      accountsWithHealthyQuota: 0,
      accountsLowOrDepleted: 0,
      accountsWithErrors: 0,
      proAccountsCount: 0,
      lastUpdated: new Date().toISOString()
    };
  }

  const getTierWeight = (tier: AccountTierType): number => {
    switch (tier) {
      case 'ENTERPRISE':
        return TIER_WEIGHTS.ENTERPRISE;
      case 'ULTRA':
        return TIER_WEIGHTS.ULTRA;
      case 'AI PREMIUM':
        return TIER_WEIGHTS['AI PREMIUM'];
      case 'PRO':
        return TIER_WEIGHTS.PRO;
      case 'STANDARD FREE':
      default:
        return TIER_WEIGHTS.FREE;
    }
  };

  const activeAcc = accounts.find((a) => a.isActive) || accounts[0];
  let sumOverallWeighted = 0;
  let totalOverallWeight = 0;

  let sumInstantWeighted = 0;
  let totalInstantWeight = 0;

  let sum5hWeighted = 0;
  let total5hWeight = 0;

  let sumWeeklyWeighted = 0;
  let totalWeeklyWeight = 0;

  let sumGeminiInstant = 0, totalGeminiInstantWeight = 0;
  let sumGemini5h = 0, totalGemini5hWeight = 0;
  let sumGeminiWeekly = 0, totalGeminiWeeklyWeight = 0;
  let sumClaudeInstant = 0, totalClaudeInstantWeight = 0;
  let sumClaude5h = 0, totalClaude5hWeight = 0;
  let sumClaudeWeekly = 0, totalClaudeWeeklyWeight = 0;

  let maxPercentage = 0;
  let healthyCount = 0;
  let lowCount = 0;
  let errorCount = 0;
  let proCount = 0;

  for (const acc of accounts) {
    const isFree = !acc.tierBadge || acc.tierBadge === 'STANDARD FREE';
    if (!isFree) {
      proCount++;
    }

    if (acc.isBanned || acc.status === 'auth_failed' || acc.status === 'banned') {
      errorCount++;
      continue;
    }

    // Skip accounts that have no quota data yet (e.g. newly added, first fetch pending)
    const hasQuotaData =
      (Array.isArray(acc.quotas) && acc.quotas.length > 0) ||
      acc.geminiGroup != null ||
      acc.claudeGptGroup != null ||
      (Array.isArray(acc.quotaGroups) && acc.quotaGroups.length > 0) ||
      acc.weeklyQuotaPercentage !== undefined ||
      acc.fiveHourQuotaPercentage !== undefined ||
      (acc.lastRefreshedAt !== undefined && acc.averageQuotaPercentage !== undefined);

    if (!hasQuotaData) {
      continue;
    }

    healthyCount++;

    const weight = getTierWeight(acc.tierBadge);

    // Check validity of Gemini and Claude buckets
    const g5h = isFree ? undefined : acc.geminiGroup?.fiveHour;
    const validG5h = !isFree && g5h && !g5h.disabled && g5h.percentage >= 0;
    const gWk = acc.geminiGroup?.weekly;
    const validGWk = gWk && !gWk.disabled && gWk.percentage >= 0;

    const c5h = isFree ? undefined : acc.claudeGptGroup?.fiveHour;
    const validC5h = !isFree && c5h && !c5h.disabled && c5h.percentage >= 0;
    const cWk = acc.claudeGptGroup?.weekly;
    const validCWk = cWk && !cWk.disabled && cWk.percentage >= 0;

    // Weekly / Capacity percentage of this account (Gemini 70% + Claude 30%)
    let pWeekly: number | undefined = acc.weeklyQuotaPercentage ?? acc.averageQuotaPercentage;
    if (pWeekly === undefined) {
      if (validGWk && validCWk) {
        pWeekly = Math.round((gWk.percentage * MODEL_WEIGHTS.GEMINI + cWk.percentage * MODEL_WEIGHTS.CLAUDE) / (MODEL_WEIGHTS.GEMINI + MODEL_WEIGHTS.CLAUDE));
      } else if (validGWk) {
        pWeekly = gWk.percentage;
      } else if (validCWk) {
        pWeekly = cWk.percentage;
      }
    }

    // 1. Overall capacity: weighted sum of weekly plan quotas across healthy accounts with weekly data
    if (pWeekly !== undefined) {
      if (pWeekly > maxPercentage) maxPercentage = pWeekly;
      if (pWeekly < 20) {
        lowCount++;
      }
      sumOverallWeighted += pWeekly * weight;
      totalOverallWeight += weight;
    }

    // 2. Gemini Instant Quota
    let gInstant: number | undefined;
    if (isFree) {
      if (validGWk) gInstant = gWk.percentage;
    } else {
      if (validG5h && validGWk) {
        gInstant = calculateModulatedInstantQuota(g5h.percentage, gWk.percentage, SAFE_WEEKLY_THRESHOLDS.GEMINI);
      } else if (validG5h) {
        gInstant = g5h.percentage;
      } else if (validGWk) {
        gInstant = gWk.percentage;
      }
    }

    // 3. Claude Instant Quota
    let cInstant: number | undefined;
    if (isFree) {
      if (validCWk) cInstant = cWk.percentage;
    } else {
      if (validC5h && validCWk) {
        cInstant = calculateModulatedInstantQuota(c5h.percentage, cWk.percentage, SAFE_WEEKLY_THRESHOLDS.CLAUDE_GPT);
      } else if (validC5h) {
        cInstant = c5h.percentage;
      } else if (validCWk) {
        cInstant = cWk.percentage;
      }
    }

    // 4. Account Instant Quota (pInstant): only blend models that actually have data
    let pInstant: number | undefined;
    if (gInstant !== undefined && cInstant !== undefined) {
      pInstant = Math.round((gInstant * MODEL_WEIGHTS.GEMINI + cInstant * MODEL_WEIGHTS.CLAUDE) / (MODEL_WEIGHTS.GEMINI + MODEL_WEIGHTS.CLAUDE));
    } else if (gInstant !== undefined) {
      pInstant = gInstant;
    } else if (cInstant !== undefined) {
      pInstant = cInstant;
    } else {
      // Fallback to account-level aggregates if present
      if (isFree) {
        pInstant = pWeekly;
      } else {
        const acc5h = acc.fiveHourQuotaPercentage;
        if (acc5h !== undefined && pWeekly !== undefined) {
          pInstant = calculateModulatedInstantQuota(acc5h, pWeekly, SAFE_WEEKLY_THRESHOLDS.DEFAULT);
        } else if (acc5h !== undefined) {
          pInstant = acc5h;
        } else if (pWeekly !== undefined) {
          pInstant = pWeekly;
        }
      }
    }

    // Only add to instant pool if this account actually has instant data!
    if (pInstant !== undefined) {
      sumInstantWeighted += pInstant * weight;
      totalInstantWeight += weight;
    }

    // 5. 5-Hour Rolling Window aggregates (paid tiers only)
    if (!isFree) {
      let acc5hVal: number | undefined;
      if (validG5h && validC5h) {
        acc5hVal = Math.round((g5h.percentage * MODEL_WEIGHTS.GEMINI + c5h.percentage * MODEL_WEIGHTS.CLAUDE) / (MODEL_WEIGHTS.GEMINI + MODEL_WEIGHTS.CLAUDE));
      } else if (validG5h) {
        acc5hVal = g5h.percentage;
      } else if (validC5h) {
        acc5hVal = c5h.percentage;
      } else if (acc.fiveHourQuotaPercentage !== undefined) {
        acc5hVal = acc.fiveHourQuotaPercentage;
      }

      if (acc5hVal !== undefined) {
        sum5hWeighted += acc5hVal * weight;
        total5hWeight += weight;
      }
    }

    // 6. Weekly Plan Quota aggregates
    let accWkVal: number | undefined;
    if (validGWk && validCWk) {
      accWkVal = Math.round((gWk.percentage * MODEL_WEIGHTS.GEMINI + cWk.percentage * MODEL_WEIGHTS.CLAUDE) / (MODEL_WEIGHTS.GEMINI + MODEL_WEIGHTS.CLAUDE));
    } else if (validGWk) {
      accWkVal = gWk.percentage;
    } else if (validCWk) {
      accWkVal = cWk.percentage;
    } else if (pWeekly !== undefined) {
      accWkVal = pWeekly;
    }

    if (accWkVal !== undefined) {
      sumWeeklyWeighted += accWkVal * weight;
      totalWeeklyWeight += weight;
    }

    // 7. Gemini Separated Aggregates
    if (validG5h) {
      sumGemini5h += g5h.percentage * weight;
      totalGemini5hWeight += weight;
    }
    if (validGWk) {
      sumGeminiWeekly += gWk.percentage * weight;
      totalGeminiWeeklyWeight += weight;
    }
    if (gInstant !== undefined) {
      sumGeminiInstant += gInstant * weight;
      totalGeminiInstantWeight += weight;
    }

    // 8. Claude & GPT Separated Aggregates
    if (validC5h) {
      sumClaude5h += c5h.percentage * weight;
      totalClaude5hWeight += weight;
    }
    if (validCWk) {
      sumClaudeWeekly += cWk.percentage * weight;
      totalClaudeWeeklyWeight += weight;
    }
    if (cInstant !== undefined) {
      sumClaudeInstant += cInstant * weight;
      totalClaudeInstantWeight += weight;
    }
  }

  const overallPct = totalOverallWeight > 0 ? Math.round(sumOverallWeighted / totalOverallWeight) : 0;
  const instantPct = totalInstantWeight > 0 ? Math.round(sumInstantWeighted / totalInstantWeight) : 0;
  const overall5hPct = total5hWeight > 0 ? Math.round(sum5hWeighted / total5hWeight) : undefined;
  const overallWeeklyPct = totalWeeklyWeight > 0 ? Math.round(sumWeeklyWeighted / totalWeeklyWeight) : undefined;
  const geminiInstantPct = totalGeminiInstantWeight > 0 ? Math.round(sumGeminiInstant / totalGeminiInstantWeight) : undefined;
  const gemini5hPct = totalGemini5hWeight > 0 ? Math.round(sumGemini5h / totalGemini5hWeight) : undefined;
  const geminiWkPct = totalGeminiWeeklyWeight > 0 ? Math.round(sumGeminiWeekly / totalGeminiWeeklyWeight) : undefined;
  const claudeInstantPct = totalClaudeInstantWeight > 0 ? Math.round(sumClaudeInstant / totalClaudeInstantWeight) : undefined;
  const claude5hPct = totalClaude5hWeight > 0 ? Math.round(sumClaude5h / totalClaude5hWeight) : undefined;
  const claudeWkPct = totalClaudeWeeklyWeight > 0 ? Math.round(sumClaudeWeekly / totalClaudeWeeklyWeight) : undefined;
  const activePct = activeAcc ? (activeAcc.averageQuotaPercentage || 0) : 0;

  return {
    totalAccounts: accounts.length,
    activeAccountEmail: activeAcc?.email,
    instantPercentage: errorCount === accounts.length ? 0 : instantPct,
    overallPercentage: errorCount === accounts.length ? 0 : overallPct,
    geminiInstantPercentage: geminiInstantPct,
    gemini5HourPercentage: gemini5hPct,
    geminiWeeklyPercentage: geminiWkPct,
    claudeInstantPercentage: claudeInstantPct,
    claude5HourPercentage: claude5hPct,
    claudeWeeklyPercentage: claudeWkPct,
    overall5HourPercentage: overall5hPct ?? 0,
    overallWeeklyPercentage: overallWeeklyPct ?? 0,
    averageActiveAccountPercentage: activePct,
    highestAccountQuotaPercentage: maxPercentage,
    accountsWithHealthyQuota: healthyCount,
    accountsLowOrDepleted: lowCount,
    accountsWithErrors: errorCount,
    proAccountsCount: proCount,
    lastUpdated: new Date().toISOString()
  };
}
