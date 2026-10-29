import test from 'node:test';
import assert from 'node:assert';
import { QuotaService } from '../src/quota';
import { AccountInfo, AccountTierType } from '../src/types';
import {
  calculateModulatedInstantQuota,
  quotaFillClass,
  quotaTextClass,
  SAFE_WEEKLY_THRESHOLDS,
  MODEL_WEIGHTS
} from '../src/webview/src/lib/quota';

test('Comprehensive Quota Timing Scenarios', async (t) => {
  const quotaService = new QuotaService({} as any);

  await t.test('Timing T1: Reset time in past formats as Ready and keeps 5h window', () => {
    const pastResetTime = new Date(Date.now() - 3600 * 1000).toISOString(); // 1 hour ago
    const classification = quotaService.classifyQuotaWindow('gemini-3.8-flash', 'Gemini 3.8 Flash', pastResetTime);
    assert.strictEqual(classification.windowType, '5h');
    assert.strictEqual(classification.windowLabel, '5-Hour Rolling Window');

    const countdown = quotaService.formatCountdown(pastResetTime);
    assert.strictEqual(countdown, 'Ready');
  });

  await t.test('Timing T2: Reset time in genuine 5h window (<= 5.5h) classifies as 5h window', () => {
    const nearResetTime = new Date(Date.now() + 3.5 * 3600 * 1000).toISOString(); // 3.5 hours away
    const classification = quotaService.classifyQuotaWindow('gemini-3.8-flash', 'Gemini 3.8 Flash', nearResetTime);
    assert.strictEqual(classification.windowType, '5h');
    assert.strictEqual(classification.windowLabel, '5-Hour Rolling Window');

    const countdown = quotaService.formatCountdown(nearResetTime);
    assert.ok(countdown.includes('3h') || countdown.includes('2h'), `Countdown should be ~3h, got ${countdown}`);
  });

  await t.test('Timing T3: Flash model with reset time > 5.5h (e.g. 8.5h) classifies as Weekly Plan Quota', () => {
    const weeklyResetTime = new Date(Date.now() + 8.5 * 3600 * 1000).toISOString(); // 8.5 hours away
    const classification = quotaService.classifyQuotaWindow('gemini-3.8-flash', 'Gemini 3.8 Flash', weeklyResetTime);
    assert.strictEqual(classification.windowType, 'weekly');
    assert.strictEqual(classification.windowLabel, 'Weekly Plan Quota');
  });

  await t.test('Timing T4: Claude & GPT models classify according to physical reset duration or weekly fallback', () => {
    // Claude with 6 days reset (typical weekly cycle)
    const sixDaysReset = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString();
    const c1 = quotaService.classifyQuotaWindow('claude-sonnet-4-6', 'Claude Sonnet 4.6', sixDaysReset);
    assert.strictEqual(c1.windowType, 'weekly');

    // GPT without resetTime defaults to weekly plan quota
    const c2 = quotaService.classifyQuotaWindow('gpt-oss-120b', 'GPT-OSS 120B');
    assert.strictEqual(c2.windowType, 'weekly');
  });

  await t.test('Timing T5: Live model 5h synchronization respects 5.5h boundary', () => {
    const valid5hReset = new Date(Date.now() + 2.5 * 3600 * 1000).toISOString();
    const futureWeeklyReset = new Date(Date.now() + 12 * 3600 * 1000).toISOString();

    const raw = {
      paidTier: { id: 'g1-pro' },
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { displayName: '5 Hour Limit Remaining', window: '5h', remainingFraction: 1.0, resetTime: valid5hReset },
              { displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.50, resetTime: futureWeeklyReset }
            ]
          }
        ]
      },
      models: {
        // Model with genuine 5h consumption (60% remaining, resets in 2.5h)
        'gemini-3.8-flash': {
          displayName: 'Gemini 3.8 Flash',
          quotaInfo: { remainingFraction: 0.60, resetTime: valid5hReset }
        }
      }
    };

    const res = quotaService.processQuotaData(raw, { id: 'acc-1', email: 'user@example.com', tierBadge: 'PRO', status: 'healthy' });
    // Synchronizes 5h bucket to 60% with genuine 5h reset
    assert.strictEqual(res.geminiGroup?.fiveHour?.percentage, 60);
    assert.strictEqual(res.geminiGroup?.fiveHour?.resetTime, valid5hReset);
  });

  await t.test('Timing T6: Pro models always classify as weekly (identity-based), 5h bucket derives from Flash only', () => {
    const burstReset = new Date(Date.now() + 3.8 * 3600 * 1000).toISOString(); // 3.8 hours away
    const weeklyReset = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString();

    const raw = {
      paidTier: { id: 'g1-pro' },
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.95, resetTime: weeklyReset },
              { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.81, resetTime: burstReset }
            ]
          }
        ]
      },
      models: {
        'gemini-2.5-pro': {
          displayName: 'Gemini 2.5 Pro',
          quotaInfo: { remainingFraction: 0.81, resetTime: burstReset }
        },
        'gemini-3.8-flash-tiered': {
          displayName: 'Gemini 3.8 Flash',
          quotaInfo: { remainingFraction: 0.81, resetTime: burstReset }
        }
      }
    };

    const res = quotaService.processQuotaData(raw, { id: 'acc-pro', email: 'pro.user@example.com', tierBadge: 'PRO', status: 'healthy' });
    // Pro model is classified as weekly based on model identity (Pro always = weekly)
    const proModel = res.quotas.find((q) => q.id === 'gemini-2.5-pro');
    assert.strictEqual(proModel?.windowType, 'weekly');
    assert.strictEqual(proModel?.windowLabel, 'Weekly Plan Quota');

    // 5h bucket derives from Flash models only, remains authentic at 81%
    assert.strictEqual(res.geminiGroup?.fiveHour?.percentage, 81);
    assert.strictEqual(res.geminiGroup?.fiveHour?.resetTime, burstReset);

    // Weekly bucket from UQS groups is preserved at 95% with weeklyReset
    assert.strictEqual(res.geminiGroup?.weekly?.percentage, 95);
    assert.strictEqual(res.geminiGroup?.weekly?.resetTime, weeklyReset);
  });

  await t.test('Timing T7: Weekly reset near expiry (< 5.5h, e.g. 4.0h) is NEVER misclassified as 5h rolling window', () => {
    const weeklyResetNear = new Date(Date.now() + 4.0 * 3600 * 1000).toISOString(); // 4.0 hours away
    const fiveHourReset = new Date(Date.now() + 1.5 * 3600 * 1000).toISOString(); // 1.5 hours away

    const raw = {
      paidTier: { id: 'g1-pro' },
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.92, resetTime: weeklyResetNear },
              { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.70, resetTime: fiveHourReset }
            ]
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { bucketId: 'claude_gpt-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.88, resetTime: weeklyResetNear }
            ]
          }
        ]
      },
      models: {
        'gemini-2.5-pro': {
          displayName: 'Gemini 2.5 Pro',
          quotaInfo: { remainingFraction: 0.92, resetTime: weeklyResetNear }
        },
        'gemini-3.8-flash': {
          displayName: 'Gemini 3.8 Flash',
          quotaInfo: { remainingFraction: 0.70, resetTime: fiveHourReset }
        },
        'claude-3-7-sonnet': {
          displayName: 'Claude 3.7 Sonnet',
          quotaInfo: { remainingFraction: 0.88, resetTime: weeklyResetNear }
        }
      }
    };

    const res = quotaService.processQuotaData(raw, { id: 'acc-weekly-4h', email: 'user@example.com', tierBadge: 'PRO', status: 'healthy' });

    // Weekly bucket remains 92% and 4.0h countdown
    assert.strictEqual(res.geminiGroup?.weekly?.percentage, 92);
    assert.strictEqual(res.geminiGroup?.weekly?.resetTime, weeklyResetNear);

    // Gemini 2.5 Pro is classified as Weekly Plan Quota despite reset time being 4.0h (< 5.5h)
    const proModel = res.quotas.find((q) => q.id === 'gemini-2.5-pro');
    assert.strictEqual(proModel?.windowType, 'weekly');
    assert.strictEqual(proModel?.windowLabel, 'Weekly Plan Quota');

    // Claude 3.7 Sonnet is classified as Weekly Plan Quota despite reset time being 4.0h (< 5.5h)
    const claudeModel = res.quotas.find((q) => q.id === 'claude-3-7-sonnet');
    assert.strictEqual(claudeModel?.windowType, 'weekly');
    assert.strictEqual(claudeModel?.windowLabel, 'Weekly Plan Quota');

    // Flash model is correctly classified as 5-Hour Rolling Window
    const flashModel = res.quotas.find((q) => q.id === 'gemini-3.8-flash');
    assert.strictEqual(flashModel?.windowType, '5h');
    assert.strictEqual(flashModel?.windowLabel, '5-Hour Rolling Window');

    // Standalone direct calls without bucket context also correctly default Pro to Weekly
    const standalonePro = quotaService.classifyQuotaWindow('gemini-2.5-pro', 'Gemini 2.5 Pro', weeklyResetNear);
    assert.strictEqual(standalonePro.windowType, 'weekly');

    // Standalone direct calls with cross-referencing knownWeeklyResetTime
    const crossRefPro = quotaService.classifyQuotaWindow('gemini-2.5-pro', 'Gemini 2.5 Pro', weeklyResetNear, undefined, weeklyResetNear, fiveHourReset);
    assert.strictEqual(crossRefPro.windowType, 'weekly');
  });

  await t.test('Timing T8: Argon weekly quota accurately tracks Pro weekly model burn (e.g. 3%) on Pro accounts with Argon', () => {
    const weeklyReset = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    const raw = {
      paidTier: { id: 'g1-pro' },
      models: {
        'gemini-2.5-pro': {
          displayName: 'Gemini 2.5 Pro',
          quotaInfo: { remainingFraction: 0.026959257, resetTime: weeklyReset }
        },
        'gemini-4-argon': {
          displayName: 'Gemini 4 Argon',
          quotaInfo: { remainingFraction: 0.026959257, resetTime: weeklyReset }
        }
      }
    };

    const res = quotaService.processQuotaData(raw, { id: 'acc-pro-burned', email: 'pro.burned@example.com', tierBadge: 'PRO', status: 'healthy' });

    // Argon group must accurately reflect the burned Pro quota (3%)
    assert.strictEqual(res.argonGroup?.weekly?.percentage, 3);
    assert.strictEqual(res.argonGroup?.weekly?.remainingFraction, 0.026959257);
    assert.strictEqual(res.argonGroup?.weekly?.resetTime, weeklyReset);

    // gemini-4-argon model entry must exist and show 3%
    const argonModel = res.quotas.find((q) => q.id === 'gemini-4-argon');
    assert.ok(argonModel);
    assert.strictEqual(argonModel?.percentage, 3);
    assert.strictEqual(argonModel?.groupName, 'Argon Models');
    assert.strictEqual(argonModel?.windowType, 'weekly');
  });

  await t.test('Timing T9: Pro account without Argon subscription has argonGroup undefined and no fake gemini-4-argon', () => {
    const fiveHourReset = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
    const weeklyReset = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString();
    const raw = {
      paidTier: { id: 'g1-pro' },
      response: {
        groups: [
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 1.0, resetTime: weeklyReset },
              { displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1.0, resetTime: fiveHourReset }
            ]
          }
        ]
      },
      models: {
        'gemini-2.5-flash': {
          displayName: 'Gemini 2.5 Flash',
          quotaInfo: { remainingFraction: 0.96, resetTime: fiveHourReset }
        },
        'gemini-2.5-pro': {
          displayName: 'Gemini 2.5 Pro',
          quotaInfo: { remainingFraction: 0.96, resetTime: fiveHourReset }
        }
      }
    };

    const res = quotaService.processQuotaData(raw, { id: 'acc-pro-no-argon', email: 'user@example.com', tierBadge: 'PRO', status: 'healthy' });

    // Must strictly be undefined: Pro accounts without Argon do NOT show an Argon group
    assert.strictEqual(res.argonGroup, undefined);
    assert.strictEqual(res.quotaGroups?.some((g) => g.id === 'argon'), false);

    // No gemini-4-argon model entry synthesized
    const argonModel = res.quotas.find((q) => q.id === 'gemini-4-argon');
    assert.strictEqual(argonModel, undefined);
  });

  await t.test('Timing T10: Gemini 5h rolling model (96%) never overwrites Gemini weekly quota (74%)', () => {
    const fiveHourReset = new Date(Date.now() + 4.5 * 3600 * 1000).toISOString();
    const weeklyReset = new Date(Date.now() + 6.5 * 24 * 3600 * 1000).toISOString();
    const raw = {
      paidTier: { id: 'g1-pro' },
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.74, resetTime: weeklyReset },
              { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1.0 }
            ]
          }
        ]
      },
      models: {
        'gemini-2.5-flash': {
          displayName: 'Gemini 2.5 Flash',
          quotaInfo: { remainingFraction: 0.96, resetTime: fiveHourReset }
        },
        'gemini-2.5-pro': {
          displayName: 'Gemini 2.5 Pro',
          quotaInfo: { remainingFraction: 0.96, resetTime: fiveHourReset }
        }
      }
    };

    const res = quotaService.processQuotaData(raw, { id: 'acc-decoupled', email: 'user@example.com', tierBadge: 'PRO', status: 'healthy' });

    // Weekly MUST strictly remain 74% and NOT be overwritten by the 96% 5h consumption!
    assert.strictEqual(res.geminiGroup?.weekly?.percentage, 74);
    assert.strictEqual(res.geminiGroup?.weekly?.remainingFraction, 0.74);

    // 5h rolling limit MUST take the 96% from the 5h models
    assert.strictEqual(res.geminiGroup?.fiveHour?.percentage, 96);
    assert.strictEqual(res.geminiGroup?.fiveHour?.remainingFraction, 0.96);
  });
});

test('Comprehensive Account States and Tier Calculations', async (t) => {
  const quotaService = new QuotaService({} as any);

  await t.test('State S1: Healthy Active Pro Account', () => {
    const raw = {
      paidTier: { id: 'g1-pro' },
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { displayName: '5 Hour Limit Remaining', window: '5h', remainingFraction: 0.80 },
              { displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.90 }
            ]
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { displayName: '5 Hour Limit Remaining', window: '5h', remainingFraction: 0.80 },
              { displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.90 }
            ]
          }
        ]
      }
    };

    const res = quotaService.processQuotaData(raw, { id: 'acc-pro', email: 'pro.user@example.com', tierBadge: 'PRO', status: 'healthy' });
    assert.strictEqual(res.tierBadge, 'PRO');
    assert.strictEqual(res.status, 'healthy');
    assert.strictEqual(res.has5HourQuota, true);
    assert.strictEqual(res.hasWeeklyQuota, true);
    assert.strictEqual(res.fiveHourPercentage, 80);
    assert.strictEqual(res.weeklyPercentage, 90);
  });

  await t.test('State S2: Standard Free Account strips 5h and uses Free Tier weight', () => {
    const raw = {
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.75 }
            ]
          }
        ]
      }
    };

    const res = quotaService.processQuotaData(raw, { id: 'acc-free', email: 'free.user@example.com', tierBadge: 'STANDARD FREE', status: 'healthy' });
    assert.strictEqual(res.tierBadge, 'STANDARD FREE');
    assert.strictEqual(res.has5HourQuota, false);
    assert.strictEqual(res.fiveHourPercentage, undefined);
    assert.strictEqual(res.geminiGroup?.fiveHour, undefined);
    assert.strictEqual(res.geminiGroup?.weekly?.percentage, 75);
  });

  await t.test('State S3: Ultra and Enterprise Tiers detected accurately', () => {
    const rawUltra = {
      currentTier: { id: 'gemini_ultra', name: 'Google AI Ultra' },
      response: { groups: [{ displayName: 'Gemini Models', buckets: [{ window: 'weekly', remainingFraction: 1.0 }] }] }
    };
    const resUltra = quotaService.processQuotaData(rawUltra, { id: 'ultra', email: 'ultra@example.com' });
    assert.strictEqual(resUltra.tierBadge, 'ULTRA');

    const rawEnterprise = {
      currentTier: { id: 'workspace_enterprise', name: 'Antigravity Enterprise' },
      response: { groups: [{ displayName: 'Gemini Models', buckets: [{ window: 'weekly', remainingFraction: 1.0 }] }] }
    };
    const resEnterprise = quotaService.processQuotaData(rawEnterprise, { id: 'ent', email: 'corp@example.com' });
    assert.strictEqual(resEnterprise.tierBadge, 'ENTERPRISE');
  });

  await t.test('State S4: Overall Pool Summary excludes Banned, Auth-Failed, and Uninitialized accounts', () => {
    const healthyPro: AccountInfo = {
      id: 'h1',
      email: 'h1@example.com',
      tierBadge: 'PRO',
      status: 'healthy',
      isBanned: false,
      fiveHourQuotaPercentage: 100,
      weeklyQuotaPercentage: 100,
      geminiGroup: { id: 'gemini', name: 'Gemini', fiveHour: { percentage: 100, disabled: false }, weekly: { percentage: 100, disabled: false } }
    };

    const authFailed: AccountInfo = {
      id: 'e1',
      email: 'e1@example.com',
      tierBadge: 'PRO',
      status: 'auth_failed',
      isBanned: false,
      fiveHourQuotaPercentage: 0,
      weeklyQuotaPercentage: 0
    };

    const banned: AccountInfo = {
      id: 'b1',
      email: 'b1@example.com',
      tierBadge: 'PRO',
      status: 'banned',
      isBanned: true,
      fiveHourQuotaPercentage: 0,
      weeklyQuotaPercentage: 0
    };

    const uninitialized: AccountInfo = {
      id: 'u1',
      email: 'u1@example.com',
      tierBadge: 'PRO',
      status: 'healthy',
      isBanned: false,
      quotas: []
    };

    const summary = quotaService.calculateOverallSummary([healthyPro, authFailed, banned, uninitialized]);

    // Error accounts count
    assert.strictEqual(summary.accountsWithErrors, 2, 'Auth-failed and banned should be counted in accountsWithErrors');
    assert.strictEqual(summary.accountsWithHealthyQuota, 1, 'Only healthy account with data counted as healthy');
    assert.strictEqual(summary.overallPercentage, 100, 'Capacity should remain 100% (uninit and errors not diluting)');
    assert.strictEqual(summary.instantPercentage, 100, 'Instant pool should remain 100%');
  });
});

test('Freshness and Stale Quota Synchronization', async (t) => {
  const quotaService = new QuotaService({} as any);

  await t.test('Uninitialized account without lastRefreshedAt is stale', () => {
    const unrefreshed: AccountInfo = { id: '1', email: 'user@example.com' };
    assert.strictEqual(quotaService.isAccountStale(unrefreshed), true);
  });

  await t.test('Account refreshed 10 seconds ago (< 30s) is fresh', () => {
    const fresh: AccountInfo = {
      id: '2',
      email: 'fresh@example.com',
      lastRefreshedAt: new Date(Date.now() - 10000).toISOString()
    };
    assert.strictEqual(quotaService.isAccountStale(fresh), false);
  });

  await t.test('Account refreshed 35 seconds ago (>= 30s) is stale', () => {
    const stale: AccountInfo = {
      id: '3',
      email: 'stale@example.com',
      lastRefreshedAt: new Date(Date.now() - 35000).toISOString()
    };
    assert.strictEqual(quotaService.isAccountStale(stale), true);
  });
});
