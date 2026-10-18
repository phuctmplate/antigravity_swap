import test from 'node:test';
import assert from 'node:assert';
import { AccountInfo, WebviewState } from '../src/types';
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

test('UI Response & Data Display Test Suite for Edge-Case Accounts', async (t) => {
  // Case 1: Healthy Active Pro Account
  const proHealthy: AccountInfo = {
    id: 'acc-pro-healthy',
    email: 'pro.active@gmail.com',
    name: 'Active Pro User',
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
  };

  // Case 2: Account with Quota Error / Unfetched & NO Fallback Cache
  const proNoFallbackError: AccountInfo = {
    id: 'acc-pro-nofallback',
    email: 'error.nofallback@gmail.com',
    name: 'Unfetched Error (No Fallback)',
    isActive: false,
    status: 'healthy',
    accountType: 'Google AI Pro',
    tierBadge: 'PRO',
    statusMessage: 'Quota fetch failed · No cache available',
    has5HourQuota: false,
    hasWeeklyQuota: false,
    fiveHourQuotaPercentage: undefined,
    weeklyQuotaPercentage: undefined,
    averageQuotaPercentage: undefined,
    quotas: []
  };

  // Case 3: Standard Free Account (No 5h window, weekly only)
  const freeAccount: AccountInfo = {
    id: 'acc-free-tier',
    email: 'free.developer@gmail.com',
    name: 'Free Tier User',
    isActive: false,
    status: 'healthy',
    accountType: 'Standard Free',
    tierBadge: 'STANDARD FREE',
    has5HourQuota: false,
    hasWeeklyQuota: true,
    fiveHourQuotaPercentage: undefined,
    weeklyQuotaPercentage: 92,
    averageQuotaPercentage: 92
  };

  // Case 4: Depleted / Low Quota Account
  const depletedAccount: AccountInfo = {
    id: 'acc-depleted',
    email: 'depleted.warning@gmail.com',
    name: 'Depleted Account',
    isActive: false,
    status: 'low_balance',
    accountType: 'Google AI Pro',
    tierBadge: 'PRO',
    has5HourQuota: true,
    hasWeeklyQuota: true,
    fiveHourQuotaPercentage: 3,
    weeklyQuotaPercentage: 12,
    averageQuotaPercentage: 8
  };

  // Case 5: Auth Failed Account
  const authFailedAccount: AccountInfo = {
    id: 'acc-auth-failed',
    email: 'auth.expired@gmail.com',
    name: 'Expired Session',
    isActive: false,
    status: 'auth_failed',
    accountType: 'Google AI Pro',
    tierBadge: 'PRO',
    statusMessage: 'Session expired. Re-login required.',
    quotas: []
  };

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
  const ultraAccount: AccountInfo = {
    id: 'acc-ultra',
    email: 'ultra.dev@gmail.com',
    name: 'Ultra Power User',
    isActive: false,
    status: 'healthy',
    accountType: 'Google AI Ultra',
    tierBadge: 'ULTRA',
    has5HourQuota: true,
    hasWeeklyQuota: true,
    fiveHourQuotaPercentage: 95,
    weeklyQuotaPercentage: 98,
    averageQuotaPercentage: 96
  };

  await t.test('Case 6: Ultra Tier Account correctly formats quota and tier', () => {
    assert.strictEqual(ultraAccount.tierBadge, 'ULTRA');
    assert.strictEqual(getDisplayPercentage(ultraAccount.fiveHourQuotaPercentage), '95%');
    assert.strictEqual(getDisplayPercentage(ultraAccount.weeklyQuotaPercentage), '98%');
  });

  // Case 7: Enterprise Tier Account
  const enterpriseAccount: AccountInfo = {
    id: 'acc-enterprise',
    email: 'corp.dev@enterprise.com',
    name: 'Enterprise Engineer',
    isActive: false,
    status: 'healthy',
    accountType: 'Antigravity Enterprise',
    tierBadge: 'ENTERPRISE',
    has5HourQuota: true,
    hasWeeklyQuota: true,
    fiveHourQuotaPercentage: 100,
    weeklyQuotaPercentage: 100,
    averageQuotaPercentage: 100
  };

  await t.test('Case 7: Enterprise Tier Account correctly formats quota and tier', () => {
    assert.strictEqual(enterpriseAccount.tierBadge, 'ENTERPRISE');
    assert.strictEqual(getDisplayPercentage(enterpriseAccount.fiveHourQuotaPercentage), '100%');
  });

  // Case 8: Banned Account
  const bannedAccount: AccountInfo = {
    id: 'acc-banned',
    email: 'banned.user@gmail.com',
    name: 'Banned User',
    isActive: false,
    status: 'banned',
    isBanned: true,
    banReason: 'Account suspended by Google Terms of Service.',
    accountType: 'Google AI Pro',
    tierBadge: 'PRO',
    quotas: []
  };

  await t.test('Case 8: Banned Account shows banned state and empty quotas format as -%', () => {
    assert.strictEqual(bannedAccount.isBanned, true);
    assert.strictEqual(bannedAccount.status, 'banned');
    assert.strictEqual(getDisplayPercentage(bannedAccount.averageQuotaPercentage), '-%');
  });

  // Case 9: 100% 5h Burst with 25% Weekly Capacity (burst session scenario)
  const burstWithLowWeekly: AccountInfo = {
    id: 'acc-burst-low-weekly',
    email: 'pro.burst@gmail.com',
    name: 'Burst Account',
    isActive: false,
    status: 'healthy',
    accountType: 'Google AI Pro',
    tierBadge: 'PRO',
    has5HourQuota: true,
    hasWeeklyQuota: true,
    fiveHourQuotaPercentage: 100,
    weeklyQuotaPercentage: 25,
    averageQuotaPercentage: 36,
    fiveHourResetCountdown: '4h 58m',
    weeklyResetCountdown: '6d 18h',
    geminiGroup: {
      id: 'gemini',
      name: 'Gemini Models',
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
  };

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
});
