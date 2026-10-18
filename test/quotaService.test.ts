import test from 'node:test';
import assert from 'node:assert';
import { QuotaService } from '../src/quota';
import { MOCK_RAW_RESPONSES, MOCK_PRO_HEALTHY, MOCK_FREE_HEALTHY, ALL_MOCK_ACCOUNTS } from './mocks/mockAccounts';

const dummyOAuthService: any = {
  refreshAccessToken: async () => ({ accessToken: 'mock-token', refreshToken: 'mock-refresh', expiresAt: Date.now() + 3600000 })
};

const quotaService = new QuotaService(dummyOAuthService);

test('Bucket detection helper tests', async (t) => {
  await t.test('is5HourBucket matches various Google API bucket representations', () => {
    assert.strictEqual(QuotaService.is5HourBucket('5h', 'gemini-5h', '5 Hour Limit Remaining'), true);
    assert.strictEqual(QuotaService.is5HourBucket('', 'gemini-5h', '5-Hour Limit Remaining'), true);
    assert.strictEqual(QuotaService.is5HourBucket('', '', 'Five Hour Limit Remaining'), true);
    assert.strictEqual(QuotaService.is5HourBucket('5_hour', '', ''), true);
    assert.strictEqual(QuotaService.is5HourBucket('', 'rolling_burst', 'Rolling Limit'), true);
    assert.strictEqual(QuotaService.is5HourBucket('weekly', 'claude-weekly', 'Weekly Limit Remaining'), false);
  });

  await t.test('isWeeklyBucket matches various Google API weekly plan representations', () => {
    assert.strictEqual(QuotaService.isWeeklyBucket('weekly', 'weekly-bucket', 'Weekly Limit Remaining'), true);
    assert.strictEqual(QuotaService.isWeeklyBucket('', 'claude-weekly', 'Weekly Quota'), true);
    assert.strictEqual(QuotaService.isWeeklyBucket('7d', '', 'Weekly Plan'), true);
    assert.strictEqual(QuotaService.isWeeklyBucket('', 'plan_quota', 'Monthly/Weekly Plan'), true);
    assert.strictEqual(QuotaService.isWeeklyBucket('5h', 'gemini-5h', '5 Hour Limit Remaining'), false);
  });
});

test('Pro account quota parsing (Google AI Pro)', async (t) => {
  await t.test('Pro account with "5 Hour Limit Remaining" correctly populates Gemini 5h window', () => {
    const raw = MOCK_RAW_RESPONSES.proWithSpaceInBucketName;
    const result = quotaService.processQuotaData(raw, MOCK_PRO_HEALTHY);

    assert.strictEqual(result.tierBadge, 'PRO');
    assert.strictEqual(result.geminiGroup !== undefined, true, 'geminiGroup should be defined');
    assert.strictEqual(result.geminiGroup?.fiveHour !== undefined, true, 'geminiGroup.fiveHour must be defined');
    assert.strictEqual(result.geminiGroup?.fiveHour?.percentage, 100);
    assert.strictEqual(result.geminiGroup?.fiveHour?.window, '5h');

    // Both Gemini and Claude have quota -> statusMessage must be undefined (no false depleted!)
    assert.strictEqual(result.statusMessage, undefined, 'Healthy Pro account must not show Gemini depleted message');
    assert.strictEqual(result.status, 'healthy');
  });

  await t.test('Pro account with Gemini depleted (proto3 0.0 omission) sets Gemini depleted · Claude available', () => {
    const raw = MOCK_RAW_RESPONSES.proGeminiDepletedProto3;
    const result = quotaService.processQuotaData(raw, MOCK_PRO_HEALTHY);

    assert.strictEqual(result.geminiGroup?.fiveHour?.percentage, 0, 'Gemini 5h should be 0%');
    assert.strictEqual(result.claudeGptGroup?.fiveHour?.percentage, 100, 'Claude 5h should be 100%');
    assert.strictEqual(result.statusMessage, 'Gemini depleted · Claude available');
  });

  await t.test('Pro account with Claude depleted sets Claude depleted · Gemini available', () => {
    const raw = {
      cloudaicompanionProject: 'project-pro-123',
      currentTier: { id: 'pro', name: 'Google AI Pro' },
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [{ displayName: '5 Hour Limit Remaining', window: '5h', remainingFraction: 1.0 }]
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { displayName: '5 Hour Limit Remaining', window: '5h', remainingFraction: 0.0 },
              { displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.0 }
            ]
          }
        ]
      }
    };
    const result = quotaService.processQuotaData(raw, MOCK_PRO_HEALTHY);

    assert.strictEqual(result.geminiGroup?.fiveHour?.percentage, 100);
    assert.strictEqual(result.claudeGptGroup?.fiveHour?.percentage, 0);
    assert.strictEqual(result.statusMessage, 'Claude depleted · Gemini available');
  });

  await t.test('Pro account with both depleted sets All model quotas depleted', () => {
    const raw = {
      cloudaicompanionProject: 'project-pro-123',
      currentTier: { id: 'pro', name: 'Google AI Pro' },
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [{ displayName: '5 Hour Limit Remaining', window: '5h', remainingFraction: 0.0 }]
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { displayName: '5 Hour Limit Remaining', window: '5h', remainingFraction: 0.0 },
              { displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.0 }
            ]
          }
        ]
      }
    };
    const result = quotaService.processQuotaData(raw, MOCK_PRO_HEALTHY);

    assert.strictEqual(result.status, 'low_balance');
    assert.strictEqual(result.statusMessage, 'All model quotas depleted');
  });

  await t.test('has5hBucket guard prevents false Standard Free classification even if paidTier claims free-tier', () => {
    const raw = {
      cloudaicompanionProject: 'aicode-consumers',
      paidTier: { id: 'free-tier', name: 'Antigravity Starter Quota' },
      currentTier: { id: 'free-tier', name: 'Antigravity' },
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.9 },
              { displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1.0 }
            ]
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.5 },
              { displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1.0 }
            ]
          }
        ]
      }
    };
    const result = quotaService.processQuotaData(raw, MOCK_PRO_HEALTHY);

    assert.strictEqual(result.tierBadge, 'PRO', 'Must detect PRO when 5h rolling bucket is present');
    assert.strictEqual(result.has5HourQuota, true, 'has5HourQuota must remain true');
    assert.strictEqual(result.geminiGroup?.fiveHour?.percentage, 100);
    assert.strictEqual(result.claudeGptGroup?.fiveHour?.percentage, 100);
    assert.strictEqual(result.statusMessage, undefined, 'Must not be marked depleted');
  });
});

test('Free account quota parsing (Standard Free)', async (t) => {
  await t.test('Standard Free account with Weekly bucket never reports Gemini depleted or has 5h window', () => {
    const raw = MOCK_RAW_RESPONSES.freeTierStandard;
    const result = quotaService.processQuotaData(raw, MOCK_FREE_HEALTHY);

    assert.strictEqual(result.tierBadge, 'STANDARD FREE');
    assert.strictEqual(result.geminiGroup?.weekly !== undefined, true, 'Free account must have weekly bucket');
    assert.strictEqual(result.geminiGroup?.weekly?.percentage, 100);
    assert.strictEqual(result.geminiGroup?.fiveHour, undefined, 'Free account must NEVER have 5h bucket');
    assert.strictEqual(result.has5HourQuota, false, 'Free account has5HourQuota must be false');
    assert.strictEqual(result.statusMessage, undefined, 'Healthy Free account must not show Gemini depleted message');
    assert.strictEqual(result.status, 'healthy');
  });

  await t.test('Free account with generic bucket displayName falls back cleanly to weekly', () => {
    const raw = MOCK_RAW_RESPONSES.freeTierGenericBucket;
    const result = quotaService.processQuotaData(raw, MOCK_FREE_HEALTHY);

    assert.strictEqual(result.tierBadge, 'STANDARD FREE');
    assert.strictEqual(result.geminiGroup?.weekly !== undefined, true, 'Fallback should assign single bucket to weekly for Free');
    assert.strictEqual(result.geminiGroup?.weekly?.percentage, 85);
    assert.strictEqual(result.geminiGroup?.fiveHour, undefined);
    assert.strictEqual(result.statusMessage, undefined);
  });

  await t.test('Free account with only Gemini depleted reports Gemini quota depleted', () => {
    const raw = {
      cloudaicompanionProject: 'project-free-456',
      currentTier: 'free',
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [{ displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.0 }]
          }
        ]
      }
    };
    const result = quotaService.processQuotaData(raw, {
      ...MOCK_FREE_HEALTHY,
      claudeGptGroup: undefined
    });

    assert.strictEqual(result.status, 'low_balance');
    assert.strictEqual(result.statusMessage, 'Gemini quota depleted');
  });

  await t.test('Free account with both Gemini and Claude: Gemini 0% and Claude 80% shows Gemini depleted · Claude available', () => {
    const raw = {
      cloudaicompanionProject: 'project-free-456',
      currentTier: 'free',
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [{ displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.0 }]
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [{ displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.8 }]
          }
        ]
      }
    };
    const result = quotaService.processQuotaData(raw, MOCK_FREE_HEALTHY);

    assert.strictEqual(result.tierBadge, 'STANDARD FREE');
    assert.strictEqual(result.statusMessage, 'Gemini depleted · Claude available');
  });
});

test('Quota preservation and tier downgrade resilience', async (t) => {
  await t.test('Preserves previous bucket data when new API response omits a group', () => {
    // New response only returns Claude group, omitting Gemini group
    const rawPartial = {
      cloudaicompanionProject: 'project-pro-123',
      currentTier: { id: 'pro', name: 'Google AI Pro' },
      response: {
        groups: [
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { displayName: '5 Hour Limit Remaining', window: '5h', remainingFraction: 0.95 },
              { displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.9 }
            ]
          }
        ]
      }
    };

    const result = quotaService.processQuotaData(rawPartial, MOCK_PRO_HEALTHY);

    assert.strictEqual(result.tierBadge, 'PRO');
    assert.strictEqual(result.claudeGptGroup !== undefined, true);
    assert.strictEqual(result.geminiGroup !== undefined, true, 'Gemini group should be preserved from previous state');
    assert.strictEqual(result.geminiGroup?.fiveHour?.percentage, 100);
  });

  await t.test('Account downgraded from Pro to Free strips all 5h buckets', () => {
    // Account was previously Pro (has 5h data in MOCK_PRO_HEALTHY)
    // New response says paidTier is free-tier
    const rawDowngraded = {
      paidTier: 'free-tier',
      cloudaicompanionProject: 'project-pro-123',
      currentTier: 'free-tier',
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [{ displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.8 }]
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [{ displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.8 }]
          }
        ]
      }
    };

    const result = quotaService.processQuotaData(rawDowngraded, MOCK_PRO_HEALTHY);

    assert.strictEqual(result.tierBadge, 'STANDARD FREE', 'Tier must downgrade to STANDARD FREE');
    assert.strictEqual(result.has5HourQuota, false, 'has5HourQuota must be false');
    assert.strictEqual(result.geminiGroup?.fiveHour, undefined, 'geminiGroup 5h bucket must be purged');
    assert.strictEqual(result.claudeGptGroup?.fiveHour, undefined, 'claudeGptGroup 5h bucket must be purged');
    assert.strictEqual(result.geminiGroup?.weekly?.percentage, 80);
    assert.strictEqual(result.claudeGptGroup?.weekly?.percentage, 80);
  });
});

test('Overall capacity calculation with tier weighting and missing data exclusion', async (t) => {
  await t.test('Overall capacity includes all healthy accounts with data', () => {
    const summary = quotaService.calculateOverallSummary(ALL_MOCK_ACCOUNTS);

    assert.strictEqual(summary.totalAccounts, ALL_MOCK_ACCOUNTS.length);
    assert.strictEqual(summary.overallPercentage > 0, true, 'Overall percentage should be positive');
    assert.strictEqual(summary.proAccountsCount > 0, true, 'Pro accounts count should be counted');
  });

  await t.test('Uninitialized account with no quota data is excluded from pool calculations', () => {
    const uninitAccount: any = {
      id: 'uninit-99',
      email: 'uninit@example.com',
      tierBadge: 'PRO',
      status: 'healthy',
      isBanned: false,
      quotas: []
    };

    const healthyAccount: any = {
      id: 'healthy-99',
      email: 'healthy@example.com',
      tierBadge: 'PRO',
      status: 'healthy',
      isBanned: false,
      weeklyQuotaPercentage: 80,
      geminiGroup: {
        id: 'gemini',
        name: 'Gemini Models',
        fiveHour: { percentage: 80, disabled: false },
        weekly: { percentage: 80, disabled: false }
      }
    };

    // Summary with only healthy account vs summary with healthy + uninit
    const summaryWithout = quotaService.calculateOverallSummary([healthyAccount]);
    const summaryWith = quotaService.calculateOverallSummary([healthyAccount, uninitAccount]);

    assert.strictEqual(summaryWith.overallPercentage, summaryWithout.overallPercentage, 'Uninitialized account should not dilute overall pool');
    assert.strictEqual(summaryWith.instantPercentage, summaryWithout.instantPercentage, 'Uninitialized account should not dilute instant pool');
  });

  await t.test('Account with only Claude data does not count into Gemini pool, and instant quota uses Claude', () => {
    const claudeOnlyAccount: any = {
      id: 'claude-only-99',
      email: 'claude.only@example.com',
      tierBadge: 'PRO',
      status: 'healthy',
      isBanned: false,
      claudeGptGroup: {
        id: 'claude_gpt',
        name: 'Claude and GPT models',
        fiveHour: { percentage: 90, disabled: false },
        weekly: { percentage: 90, disabled: false }
      }
    };

    const summary = quotaService.calculateOverallSummary([claudeOnlyAccount]);

    assert.strictEqual(summary.geminiInstantPercentage, undefined, 'Gemini instant percentage should be undefined');
    assert.strictEqual(summary.gemini5HourPercentage, undefined, 'Gemini 5h should be undefined');
    assert.strictEqual(summary.geminiWeeklyPercentage, undefined, 'Gemini weekly should be undefined');
    assert.strictEqual(summary.claudeInstantPercentage, 90, 'Claude instant should be 90%');
    assert.strictEqual(summary.instantPercentage, 90, 'Account instant should be 90% (based purely on Claude)');
  });
});

test('Live Model Quota and 5h Group Synchronization', async (t) => {
  const quotaService = new QuotaService({} as any);

  await t.test('Model quota with quotaInfo overrides 100% group bucket and syncs group 5h', () => {
    const rawResponse = {
      paidTier: { id: 'g1-pro-tier' },
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              {
                bucketId: 'gemini-5h',
                displayName: 'Five Hour Limit Remaining',
                window: '5h',
                remainingFraction: 1.0,
                resetTime: '2026-10-16T23:00:00Z'
              },
              {
                bucketId: 'gemini-weekly',
                displayName: 'Weekly Limit Remaining',
                window: 'weekly',
                remainingFraction: 0.90,
                resetTime: '2026-10-21T12:00:00Z'
              }
            ]
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              {
                bucketId: '3p-weekly',
                displayName: 'Weekly Limit Remaining',
                window: 'weekly',
                remainingFraction: 0.50,
                resetTime: '2026-10-16T19:00:00Z'
              },
              {
                bucketId: '3p-5h',
                displayName: 'Five Hour Limit Remaining',
                window: '5h',
                remainingFraction: 1.0,
                resetTime: '2026-10-16T23:00:00Z'
              }
            ]
          }
        ]
      },
      models: {
        'gemini-3.8-flash-tiered': {
          displayName: 'Gemini 3.8 Flash',
          quotaInfo: {
            remainingFraction: 0.76,
            resetTime: '2026-10-16T21:44:20Z'
          }
        },
        'claude-sonnet-4-6': {
          displayName: 'Claude Sonnet 4.6',
          quotaInfo: {
            remainingFraction: 0.50,
            resetTime: '2026-10-16T19:00:00Z'
          }
        }
      }
    };

    const account: any = {
      id: 'acc-1',
      email: 'test@example.com',
      tierBadge: 'PRO',
      status: 'healthy'
    };

    const res = quotaService.processQuotaData(rawResponse, account);

    // Verify model quotas
    const flashModel = res.quotas.find((q) => q.id.includes('3.8-flash'));
    assert.ok(flashModel, 'Gemini 3.8 Flash model should be present');
    assert.strictEqual(flashModel?.percentage, 76, 'Gemini 3.8 Flash should reflect live model quota 76% (not 100%)');
    assert.strictEqual(flashModel?.windowType, '5h', 'Flash model should be 5h window');

    // Verify Gemini 5h group bucket was synchronized to match the 5h model
    assert.ok(res.geminiGroup?.fiveHour, 'Gemini 5h bucket should exist');
    assert.strictEqual(res.geminiGroup?.fiveHour?.percentage, 76, 'Gemini 5h group bucket should sync to 76%');
    assert.strictEqual(res.geminiGroup?.fiveHour?.resetTime, '2026-10-16T21:44:20Z', 'Reset time should sync to model reset');

    // Verify overall weekly percentage is weighted correctly (Gemini 90%, Claude 50%)
    // Math.round((90 * 0.85 + 50 * 0.15) / 1) = 84%
    assert.strictEqual(res.weeklyPercentage, 84, 'Weekly percentage should be weighted combination ~84%');
  });

  await t.test('Model with weekly reset time (> 5.5h away) does NOT corrupt 5h bucket percentage or reset time', () => {
    // Current time + 8.5 hours (weekly reset time)
    const futureWeeklyReset = new Date(Date.now() + 8.5 * 3600 * 1000).toISOString();
    // Current time + 4.9 hours (legitimate 5h rolling reset time)
    const valid5hReset = new Date(Date.now() + 4.9 * 3600 * 1000).toISOString();

    const rawResponse = {
      paidTier: { id: 'g1-pro-tier' },
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              {
                bucketId: 'gemini-5h',
                displayName: 'Five Hour Limit Remaining',
                window: '5h',
                remainingFraction: 1.0,
                resetTime: valid5hReset
              },
              {
                bucketId: 'gemini-weekly',
                displayName: 'Weekly Limit Remaining',
                window: 'weekly',
                remainingFraction: 0.25,
                resetTime: futureWeeklyReset
              }
            ]
          }
        ]
      },
      models: {
        'gemini-3.8-flash-tiered': {
          displayName: 'Gemini 3.8 Flash',
          quotaInfo: {
            remainingFraction: 0.25,
            resetTime: futureWeeklyReset
          }
        }
      }
    };

    const account: any = {
      id: 'acc-weekly-restricted',
      email: 'pro.active@gmail.com',
      tierBadge: 'PRO',
      status: 'healthy'
    };

    const res = quotaService.processQuotaData(rawResponse, account);

    // 1. Gemini 5h bucket must preserve its authentic 100% and its legitimate 5h reset time (~4.9h)
    assert.strictEqual(res.geminiGroup?.fiveHour?.percentage, 100, '5h bucket must remain 100%');
    assert.strictEqual(res.geminiGroup?.fiveHour?.resetTime, valid5hReset, '5h bucket must retain its valid 5h reset time');

    // 2. Gemini Weekly bucket retains 25% and 8.5h reset time
    assert.strictEqual(res.geminiGroup?.weekly?.percentage, 25, 'Weekly bucket must be 25%');
    assert.strictEqual(res.geminiGroup?.weekly?.resetTime, futureWeeklyReset, 'Weekly bucket has 8.5h reset');

    // 3. Flash model is constrained by weekly cycle, so its windowType must be weekly
    const flashModel = res.quotas.find((q) => q.id.includes('3.8-flash'));
    assert.strictEqual(flashModel?.windowType, 'weekly', 'Flash model resetting in 8.5h must be classified as weekly');
  });
});
