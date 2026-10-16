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
});
