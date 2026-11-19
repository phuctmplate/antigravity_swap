import test from 'node:test';
import assert from 'node:assert';
import { AccountInfo } from '../src/types';
import {
  calculateModulatedInstantQuota,
  quotaFillClass,
  quotaTextClass,
  SAFE_WEEKLY_THRESHOLDS
} from '../src/webview/src/lib/quota';

// Helper function mirroring AccountCard and ModelQuotas placeholder logic
function getDisplayPercentage(val: number | null | undefined): string {
  if (val === null || val === undefined || isNaN(val)) {
    return '-%';
  }
  return `${Math.round(val)}%`;
}

function createMockAccount(id: string, email: string, name: string, overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id,
    email,
    name,
    isActive: false,
    status: 'healthy',
    accountType: 'Google AI Pro',
    tierBadge: 'PRO',
    addedAt: '2026-10-20T00:00:00.000Z',
    quotas: [],
    hasWeeklyQuota: true,
    has5HourQuota: true,
    ...overrides
  };
}

test('UI Response & Data Display Test Suite for Edge-Case Accounts', async (t) => {
  // Case 1: Healthy Active Pro Account
  const proHealthy: AccountInfo = createMockAccount('acc-pro-healthy', 'pro.active@gmail.com', 'Active Pro User', {
    isActive: true,
    status: 'healthy',
    accountType: 'Google AI Pro',
    tierBadge: 'PRO',
    has5HourQuota: true,
    hasWeeklyQuota: true,
    fiveHourQuotaPercentage: 82,
    weeklyQuotaPercentage: 85,
    averageQuotaPercentage: 84,
    geminiGroup: {
      id: 'gemini',
      name: 'Gemini Models',
      buckets: [],
      fiveHour: {
        bucketId: 'gemini-5h',
        displayName: '5 Hour Limit Remaining',
        window: '5h',
        percentage: 82,
        remainingFraction: 0.82
      },
      weekly: {
        bucketId: 'gemini-weekly',
        displayName: 'Weekly Limit Remaining',
        window: 'weekly',
        percentage: 85,
        remainingFraction: 0.85
      }
    }
  });

  // Case 2: Account with Quota Error / Unfetched & NO Fallback Cache
  const proNoFallbackError: AccountInfo = createMockAccount('acc-pro-nofallback', 'error.nofallback@gmail.com', 'Unfetched Error (No Fallback)', {
    statusMessage: 'Quota fetch failed · No cache available',
    has5HourQuota: false,
    hasWeeklyQuota: false,
    fiveHourQuotaPercentage: undefined,
    weeklyQuotaPercentage: undefined,
    averageQuotaPercentage: undefined,
    quotas: []
  });

  // Case 3: Standard Free Account (No 5h window, weekly only)
  const freeAccount: AccountInfo = createMockAccount('acc-free-tier', 'free.developer@gmail.com', 'Free Tier User', {
    accountType: 'Standard Free',
    tierBadge: 'STANDARD FREE',
    has5HourQuota: false,
    hasWeeklyQuota: true,
    fiveHourQuotaPercentage: undefined,
    weeklyQuotaPercentage: 92,
    averageQuotaPercentage: 92
  });

  // Case 4: Depleted / Low Quota Account
  const depletedAccount: AccountInfo = createMockAccount('acc-depleted', 'depleted.warning@gmail.com', 'Depleted Account', {
    status: 'low_balance',
    has5HourQuota: true,
    hasWeeklyQuota: true,
    fiveHourQuotaPercentage: 3,
    weeklyQuotaPercentage: 12,
    averageQuotaPercentage: 8
  });

  // Case 5: Auth Failed Account
  const authFailedAccount: AccountInfo = createMockAccount('acc-auth-failed', 'auth.expired@gmail.com', 'Expired Session', {
    status: 'auth_failed',
    statusMessage: 'Session expired. Re-login required.',
    quotas: []
  });

  await t.test('Case 1: Healthy Pro displays accurate numbers & emerald status', () => {
    assert.strictEqual(getDisplayPercentage(proHealthy.fiveHourQuotaPercentage), '82%');
    assert.strictEqual(getDisplayPercentage(proHealthy.weeklyQuotaPercentage), '85%');
    assert.strictEqual(quotaFillClass(proHealthy.fiveHourQuotaPercentage!), 'bg-emerald-500');
    assert.strictEqual(quotaTextClass(proHealthy.fiveHourQuotaPercentage!), 'text-emerald-400');
    
    // Check modulation
    const instant = calculateModulatedInstantQuota(82, 85, SAFE_WEEKLY_THRESHOLDS.GEMINI);
    assert.strictEqual(instant, 82);
  });

  await t.test('Case 2: Error with no fallback MUST format as -% instead of -- or NaN', () => {
    assert.strictEqual(getDisplayPercentage(proNoFallbackError.fiveHourQuotaPercentage), '-%');
    assert.strictEqual(getDisplayPercentage(proNoFallbackError.weeklyQuotaPercentage), '-%');
    assert.strictEqual(getDisplayPercentage(proNoFallbackError.averageQuotaPercentage), '-%');
    assert.strictEqual(getDisplayPercentage(null), '-%');
    assert.strictEqual(getDisplayPercentage(undefined), '-%');
  });

  await t.test('Case 3: Standard Free account has undefined 5h and valid weekly percentage', () => {
    assert.strictEqual(freeAccount.has5HourQuota, false);
    assert.strictEqual(getDisplayPercentage(freeAccount.fiveHourQuotaPercentage), '-%');
    assert.strictEqual(getDisplayPercentage(freeAccount.weeklyQuotaPercentage), '92%');
  });

  await t.test('Case 4: Depleted account triggers critical rose warning classes', () => {
    assert.strictEqual(getDisplayPercentage(depletedAccount.fiveHourQuotaPercentage), '3%');
    assert.strictEqual(quotaFillClass(depletedAccount.fiveHourQuotaPercentage!), 'bg-rose-500');
    assert.strictEqual(quotaTextClass(depletedAccount.fiveHourQuotaPercentage!), 'text-rose-400');
  });

  await t.test('Case 5: Auth failed account handles empty quotas gracefully', () => {
    assert.strictEqual(authFailedAccount.status, 'auth_failed');
    assert.strictEqual(getDisplayPercentage(authFailedAccount.averageQuotaPercentage), '-%');
  });

  // Case 6: Ultra Tier Account
  const ultraAccount: AccountInfo = createMockAccount('acc-ultra', 'ultra.dev@gmail.com', 'Ultra Power User', {
    accountType: 'Google AI Ultra',
    tierBadge: 'ULTRA',
    fiveHourQuotaPercentage: 95,
    weeklyQuotaPercentage: 98,
    averageQuotaPercentage: 96
  });

  await t.test('Case 6: Ultra Tier Account correctly formats quota and tier', () => {
    assert.strictEqual(ultraAccount.tierBadge, 'ULTRA');
    assert.strictEqual(getDisplayPercentage(ultraAccount.fiveHourQuotaPercentage), '95%');
    assert.strictEqual(getDisplayPercentage(ultraAccount.weeklyQuotaPercentage), '98%');
  });

  // Case 7: Enterprise Tier Account
  const enterpriseAccount: AccountInfo = createMockAccount('acc-enterprise', 'corp.dev@enterprise.com', 'Enterprise Engineer', {
    accountType: 'Antigravity Enterprise',
    tierBadge: 'ENTERPRISE',
    fiveHourQuotaPercentage: 100,
    weeklyQuotaPercentage: 100,
    averageQuotaPercentage: 100
  });

  await t.test('Case 7: Enterprise Tier Account correctly formats quota and tier', () => {
    assert.strictEqual(enterpriseAccount.tierBadge, 'ENTERPRISE');
    assert.strictEqual(getDisplayPercentage(enterpriseAccount.fiveHourQuotaPercentage), '100%');
  });

  // Case 8: Banned Account
  const bannedAccount: AccountInfo = createMockAccount('acc-banned', 'banned.user@gmail.com', 'Banned User', {
    status: 'banned',
    isBanned: true,
    banReason: 'Account suspended by Google Terms of Service.',
    quotas: []
  });

  await t.test('Case 8: Banned Account shows banned state and empty quotas format as -%', () => {
    assert.strictEqual(bannedAccount.isBanned, true);
    assert.strictEqual(bannedAccount.status, 'banned');
    assert.strictEqual(getDisplayPercentage(bannedAccount.averageQuotaPercentage), '-%');
  });

  // Case 9: 100% 5h Burst with 25% Weekly Capacity (burst session scenario)
  const burstWithLowWeekly: AccountInfo = createMockAccount('acc-burst-low-weekly', 'pro.burst@gmail.com', 'Burst Account', {
    fiveHourQuotaPercentage: 100,
    weeklyQuotaPercentage: 25,
    averageQuotaPercentage: 36,
    fiveHourResetCountdown: '4h 58m',
    weeklyResetCountdown: '6d 18h',
    geminiGroup: {
      id: 'gemini',
      name: 'Gemini Models',
      buckets: [],
      fiveHour: {
        bucketId: 'gemini-5h',
        displayName: 'Five Hour Limit Remaining',
        window: '5h',
        percentage: 100,
        remainingFraction: 1.0,
        resetCountdown: '4h 58m'
      },
      weekly: {
        bucketId: 'gemini-weekly',
        displayName: 'Weekly Limit Remaining',
        window: 'weekly',
        percentage: 25,
        remainingFraction: 0.25,
        resetCountdown: '6d 18h'
      }
    }
  });

  await t.test('Case 9: 100% 5h with 25% Weekly displays distinct 5h and Weekly numbers, and modulates Instant properly', () => {
    const g5h = burstWithLowWeekly.geminiGroup!.fiveHour!;
    const gWk = burstWithLowWeekly.geminiGroup!.weekly!;

    assert.strictEqual(getDisplayPercentage(g5h.percentage), '100%');
    assert.strictEqual(g5h.resetCountdown, '4h 58m');
    assert.strictEqual(getDisplayPercentage(gWk.percentage), '25%');
    assert.strictEqual(gWk.resetCountdown, '6d 18h');

    // At 25% weekly quota, Gemini has enough fuel for 1 full burst session (healthFactor = 1.0)
    const instantAtThreshold = calculateModulatedInstantQuota(g5h.percentage, gWk.percentage, SAFE_WEEKLY_THRESHOLDS.GEMINI);
    assert.strictEqual(instantAtThreshold, 100, 'Instant quota at 25% safe threshold is 100%');

    // Below 25% weekly quota (e.g. 10%), instant quota attenuates: 100 * (10 / 25) = 40%
    const attenuatedInstant = calculateModulatedInstantQuota(100, 10, SAFE_WEEKLY_THRESHOLDS.GEMINI);
    assert.strictEqual(attenuatedInstant, 40, 'Instant quota attenuates to 40% when weekly quota is 10%');

    // At 0% weekly quota, instant quota drops to 0%
    const depletedInstant = calculateModulatedInstantQuota(100, 0, SAFE_WEEKLY_THRESHOLDS.GEMINI);
    assert.strictEqual(depletedInstant, 0, 'Instant quota is 0% when weekly quota is 0%');
  });

  await t.test('Case 10: Active account is automatically sorted to the top under all sort modes', () => {
    const getTierRank = (acc: any): number => {
      const badge = (acc.tierBadge || '').toUpperCase();
      const type = (acc.accountType || '').toLowerCase();
      if (badge === 'ENTERPRISE' || type.includes('enterprise')) return 1;
      if (badge === 'ULTRA' || type.includes('ultra')) return 2;
      if (badge === 'AI PREMIUM' || type.includes('premium')) return 3;
      if (badge === 'PRO' || type.includes('pro')) return 4;
      return 5;
    };

    const sortAccounts = (accs: any[], activeAccount: any, sortMode: string) => {
      const isAccActive = (acc: any): boolean => {
        return acc.isActive || (!!activeAccount && activeAccount.email === acc.email);
      };

      return [...accs].sort((a, b) => {
        const aActive = isAccActive(a);
        const bActive = isAccActive(b);
        if (aActive && !bActive) return -1;
        if (!aActive && bActive) return 1;

        if (sortMode === 'name-asc') {
          const nameA = a.name || a.email;
          const nameB = b.name || b.email;
          return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
        }
        if (sortMode === 'name-desc') {
          const nameA = a.name || a.email;
          const nameB = b.name || b.email;
          return nameB.localeCompare(nameA, undefined, { sensitivity: 'base', numeric: true });
        }
        if (sortMode === 'tier-asc') {
          const rankA = getTierRank(a);
          const rankB = getTierRank(b);
          if (rankA !== rankB) return rankB - rankA;
          const nameA = a.name || a.email;
          const nameB = b.name || b.email;
          return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
        }
        const rankA = getTierRank(a);
        const rankB = getTierRank(b);
        if (rankA !== rankB) return rankA - rankB;
        const nameA = a.name || a.email;
        const nameB = b.name || b.email;
        return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
      });
    };

    const sampleAccounts = [
      { email: 'zebra.free@example.com', name: 'Zebra Free', tierBadge: 'FREE', isActive: false },
      { email: 'alpha.ultra@example.com', name: 'Alpha Ultra', tierBadge: 'ULTRA', isActive: false },
      { email: 'beta.pro@example.com', name: 'Beta Pro (Active)', tierBadge: 'PRO', isActive: true },
      { email: 'charlie.pro@example.com', name: 'Charlie Pro', tierBadge: 'PRO', isActive: false }
    ];
    const activeAcc = sampleAccounts[2]; // beta.pro

    // Under default 'tier' sort: Active beta.pro MUST be index 0, followed by Ultra, then Charlie Pro, then Zebra Free
    const sortedTier = sortAccounts(sampleAccounts, activeAcc, 'tier');
    assert.strictEqual(sortedTier[0].email, 'beta.pro@example.com', 'Active account is at index 0 in tier sort');
    assert.strictEqual(sortedTier[1].email, 'alpha.ultra@example.com', 'Ultra follows active account in tier sort');
    assert.strictEqual(sortedTier[2].email, 'charlie.pro@example.com', 'Pro follows Ultra in tier sort');
    assert.strictEqual(sortedTier[3].email, 'zebra.free@example.com', 'Free follows Pro in tier sort');

    // Under 'name-asc' sort: Active beta.pro MUST be index 0, followed by Alpha, Charlie, Zebra
    const sortedNameAsc = sortAccounts(sampleAccounts, activeAcc, 'name-asc');
    assert.strictEqual(sortedNameAsc[0].email, 'beta.pro@example.com', 'Active account is at index 0 in name-asc sort');
    assert.strictEqual(sortedNameAsc[1].email, 'alpha.ultra@example.com');
    assert.strictEqual(sortedNameAsc[2].email, 'charlie.pro@example.com');
    assert.strictEqual(sortedNameAsc[3].email, 'zebra.free@example.com');

    // Under 'name-desc' sort: Active beta.pro MUST be index 0, followed by Zebra, Charlie, Alpha
    const sortedNameDesc = sortAccounts(sampleAccounts, activeAcc, 'name-desc');
    assert.strictEqual(sortedNameDesc[0].email, 'beta.pro@example.com', 'Active account is at index 0 in name-desc sort');
    assert.strictEqual(sortedNameDesc[1].email, 'zebra.free@example.com');
    assert.strictEqual(sortedNameDesc[2].email, 'charlie.pro@example.com');
    assert.strictEqual(sortedNameDesc[3].email, 'alpha.ultra@example.com');

    // Under 'tier-asc' sort: Active beta.pro MUST be index 0, followed by Zebra Free, Charlie Pro, Alpha Ultra
    const sortedTierAsc = sortAccounts(sampleAccounts, activeAcc, 'tier-asc');
    assert.strictEqual(sortedTierAsc[0].email, 'beta.pro@example.com', 'Active account is at index 0 in tier-asc sort');
    assert.strictEqual(sortedTierAsc[1].email, 'zebra.free@example.com');
    assert.strictEqual(sortedTierAsc[2].email, 'charlie.pro@example.com');
    assert.strictEqual(sortedTierAsc[3].email, 'alpha.ultra@example.com');
  });
});
