import test, { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { AccountInfo } from '../src/types';
import { GoogleDirectApiClient, MicroLanguageServerClient } from '../src/quota/googleDirectApiClient';
import { AccountQuotaSync } from '../src/account/accountQuotaSync';

// Mock vscode module for standalone test runner
const Module = require('module');
const origRequire = Module.prototype.require;
const ideEvents: Array<{ type: string; msg: string }> = [];

Module.prototype.require = function (id: string) {
  if (id === 'vscode') {
    return {
      window: {
        showWarningMessage: (msg: string) => {
          ideEvents.push({ type: 'warning', msg });
        },
        showInformationMessage: (msg: string) => {
          ideEvents.push({ type: 'info', msg });
        },
        showErrorMessage: (msg: string, ...items: string[]) => {
          ideEvents.push({ type: 'error', msg });
          return Promise.resolve(items[0]);
        }
      },
      commands: {
        executeCommand: (cmd: string) => {
          ideEvents.push({ type: 'command', msg: cmd });
        }
      }
    };
  }
  return origRequire.apply(this, arguments as any);
};

const { AccountAutoSwitcher } = require('../src/account/accountAutoSwitcher');

describe('MicroLanguageServerClient and Standby Quota Suite', () => {
  it('fetchViaDirectApi merges granular model consumption from daily-cloudcode-pa with group structure', async () => {
    const client = new MicroLanguageServerClient();
    const future5h = new Date(Date.now() + 2.5 * 3600 * 1000).toISOString(); // 2.5h future (within 5h)

    // Mock postJson to simulate Google PA responses
    (client as any).postJson = async (host: string, path: string) => {
      if (path === '/v1internal:loadCodeAssist') {
        return {
          cloudaicompanionProject: 'aicode-consumers',
          currentTier: { id: 'pro', name: 'Google AI Pro' }
        };
      }
      if (path === '/v1internal:retrieveUserQuota') {
        return {
          buckets: [
            {
              modelId: 'gemini-2.5-flash',
              remainingFraction: 0.95,
              resetTime: future5h
            },
            {
              // Pro model — Google returns same 5h-style resetTime for all models
              modelId: 'gemini-2.5-pro',
              remainingFraction: 0.88,
              resetTime: future5h
            }
          ]
        };
      }
      if (path === '/v1internal:retrieveUserQuotaSummary') {
        return {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                {
                  bucketId: 'gemini-weekly',
                  window: 'weekly',
                  remainingFraction: 0.9,
                  resetTime: '2026-10-25T00:00:00Z'
                }
              ]
            }
          ]
        };
      }
      return null;
    };

    // Call fetchViaDirectApi directly — fetchStandbyQuota tries headless LS first (not available in test env)
    const quota = await (client as any).fetchViaDirectApi('test-access-token', 'standby@example.com');

    assert.ok(quota.models['gemini-2.5-flash']);
    assert.strictEqual(quota.models['gemini-2.5-flash'].quotaInfo.remainingFraction, 0.95);
    assert.ok(quota.models['gemini-2.5-pro']);
    assert.strictEqual(quota.models['gemini-2.5-pro'].quotaInfo.remainingFraction, 0.88);

    // 5h bucket derives from Flash models only (Pro uses the weekly bucket).
    // gemini-2.5-flash (0.95) -> 5h bucket.
    const geminiGroup = quota.groups.find((g: any) => g.displayName === 'Gemini Models');
    assert.ok(geminiGroup);
    const fiveHourBucket = geminiGroup.buckets.find((b: any) => b.window === '5h' || b.bucketId === 'gemini-5h');
    assert.ok(fiveHourBucket);
    assert.strictEqual(fiveHourBucket.remainingFraction, 0.95);

    client.dispose();
  });


  it('probeJitCandidate returns isDepleted = true when 5h quota is <= 5%', async () => {
    const client = new MicroLanguageServerClient();

    (client as any).fetchStandbyQuota = async () => ({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.03, resetTime: '2026-10-19T16:00:00Z' },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.5 }
          ]
        }
      ]
    });

    const result = await client.probeJitCandidate('mock-token', 'depleted@example.com');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.isDepleted, true);
    assert.strictEqual(result.fiveHourPercentage, 3);
    assert.strictEqual(result.weeklyPercentage, 50);

    client.dispose();
  });

  it('probeJitCandidate returns isDepleted = false when quota is healthy', async () => {
    const client = new MicroLanguageServerClient();

    (client as any).fetchStandbyQuota = async () => ({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.75, resetTime: '2026-10-19T18:00:00Z' },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9 }
          ]
        }
      ]
    });

    const result = await client.probeJitCandidate('mock-token', 'healthy@example.com');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.isDepleted, false);
    assert.strictEqual(result.fiveHourPercentage, 75);
    assert.strictEqual(result.weeklyPercentage, 90);

    client.dispose();
  });
});

describe('AccountQuotaSync Staggered Carousel and External Activity Suite', () => {
  function makeMockAccount(email: string, opts: Partial<AccountInfo> = {}): AccountInfo {
    return {
      id: email,
      email,
      name: email.split('@')[0],
      addedAt: '2026-10-20T00:00:00.000Z',
      isActive: false,
      status: 'healthy',
      accountType: 'Google AI Pro',
      tierBadge: 'PRO',
      has5HourQuota: true,
      hasWeeklyQuota: true,
      quotas: [],
      averageQuotaPercentage: 80,
      fiveHourQuotaPercentage: 80,
      weeklyQuotaPercentage: 80,
      lastRefreshedAt: new Date(Date.now() - 60000).toISOString(), // 1 min ago
      ...opts
    };
  }

  it('runHeartbeatTick refreshes stale background accounts in parallel batch', async () => {
    const refreshed: string[] = [];
    const accounts = [
      makeMockAccount('active@example.com', { isActive: true, lastRefreshedAt: new Date(Date.now() - 40000).toISOString() }),
      makeMockAccount('standby1@example.com', { lastRefreshedAt: new Date(Date.now() - 60000).toISOString() }),
      makeMockAccount('standby2@example.com', { lastRefreshedAt: new Date(Date.now() - 50000).toISOString() }),
      makeMockAccount('standby3@example.com', { lastRefreshedAt: new Date(Date.now() - 1000).toISOString() }) // fresh (< 30s)
    ];

    const mockCtx = {
      checkExternalIdeSession: async () => {},
      getActiveAccount: () => accounts[0],
      getAccounts: () => accounts,
      setAccounts: (accs: any) => {},
      reloadFromStorage: async () => {},
      checkAutoSwitch: async () => {},
      notifyStateChange: () => {}
    };

    const mockStorage = {
      tryAcquireRefreshLease: () => true,
      releaseRefreshLease: () => {},
      getAccounts: () => accounts,
      saveAccounts: async () => {}
    };

    const sync = new AccountQuotaSync(mockStorage as any, {} as any, mockCtx as any);
    (sync as any).refreshAccountQuota = async (email: string) => {
      refreshed.push(email);
    };

    await sync.runHeartbeatTick();

    assert.ok(refreshed.includes('active@example.com'), 'Active stale account must be refreshed');
    assert.ok(refreshed.includes('standby1@example.com'), 'Oldest stale standby must be refreshed in batch');
    assert.ok(refreshed.includes('standby2@example.com'), 'Second oldest stale standby must be refreshed in batch');
    assert.strictEqual(refreshed.includes('standby3@example.com'), false, 'Fresh account (< 30s) must not be refreshed');
  });

  it('detects external activity when standby account quota drops on another device', async () => {
    let savedAccounts: AccountInfo[] = [];

    const mockStorage = {
      getAccountTokens: async () => ({ accessToken: 'token-123' }),
      saveAccountTokens: async () => {},
      getAccounts: () => savedAccounts,
      saveAccounts: async (accs: AccountInfo[]) => { savedAccounts = accs; },
      renewRefreshLease: () => {}
    };

    // Account currently at 90% quota, standby
    const initialStandby = makeMockAccount('standby.user@example.com', {
      isActive: false,
      fiveHourQuotaPercentage: 90,
      weeklyQuotaPercentage: 90,
      averageQuotaPercentage: 90,
      lastRefreshedAt: new Date(Date.now() - 400000).toISOString()
    });
    savedAccounts = [initialStandby];

    // Simulate quotaService returning 40% (someone burned quota on another machine!)
    const mockQuotaService = {
      fetchAccountQuotas: async () => ({
        quotas: [],
        averagePercentage: 40,
        fiveHourPercentage: 40,
        weeklyPercentage: 85,
        status: 'healthy',
        has5HourQuota: true,
        hasWeeklyQuota: true
      })
    };

    const ctx = {
      getAccounts: () => savedAccounts,
      setAccounts: (accs: AccountInfo[]) => { savedAccounts = accs; },
      getActiveAccount: () => undefined,
      reloadFromStorage: async () => {},
      checkAutoSwitch: async () => {},
      checkExternalIdeSession: async () => {},
      notifyStateChange: () => {}
    };

    const sync = new AccountQuotaSync(mockStorage as any, mockQuotaService as any, ctx as any);
    await sync.refreshAccountQuota('standby.user@example.com', true, false);

    assert.strictEqual(savedAccounts.length, 1);
    assert.strictEqual(savedAccounts[0].fiveHourQuotaPercentage, 40);
    assert.strictEqual(savedAccounts[0].externalActivityDetected, true, 'Must flag externalActivityDetected = true');
    assert.strictEqual(savedAccounts[0].lastVerifiedSource, 'micro_client');
  });
});

describe('JIT Pre-Switch Verification Guard Suite', () => {
  function makeAutoSwitchAccount(email: string, quota: number, isActive = false): AccountInfo {
    return {
      id: email,
      email,
      name: email.split('@')[0],
      addedAt: '2026-10-20T00:00:00.000Z',
      isActive,
      status: 'healthy',
      accountType: 'Google AI Pro',
      tierBadge: 'PRO',
      has5HourQuota: true,
      hasWeeklyQuota: true,
      quotas: [
        {
          id: 'gemini-5h',
          displayName: '5 Hour Limit Remaining',
          windowType: '5h',
          windowLabel: '5-Hour Window',
          percentage: quota,
          remainingFraction: quota / 100
        },
        {
          id: 'gemini-weekly',
          displayName: 'Weekly Limit Remaining',
          windowType: 'weekly',
          windowLabel: 'Weekly Quota',
          percentage: quota,
          remainingFraction: quota / 100
        }
      ],
      averageQuotaPercentage: quota,
      fiveHourQuotaPercentage: quota,
      weeklyQuotaPercentage: quota,
      lastRefreshedAt: new Date().toISOString()
    };
  }

  it('JIT Guard detects Candidate 1 was burned on another machine, marks it depleted, and switches to Candidate 2', async () => {
    let activeAcc = makeAutoSwitchAccount('active.depleted@example.com', 2, true); // Depleted <= 5%
    let candidate1 = makeAutoSwitchAccount('candidate1.stale@example.com', 85, false); // Cached as 85%
    let candidate2 = makeAutoSwitchAccount('candidate2.fresh@example.com', 70, false); // Cached as 70%

    let accounts = [activeAcc, candidate1, candidate2];
    const switchedEmails: string[] = [];
    const probedEmails: string[] = [];

    const mockStorage = {
      getAutoSwitchEnabled: () => true,
      getAutoSwitchThreshold: () => 5,
      getAutoSwitchTarget: () => 'instant',
      renewRefreshLease: () => {}
    };

    const ctx = {
      getAccounts: () => accounts,
      getActiveAccount: () => activeAcc,
      switchAccount: async (email: string) => {
        switchedEmails.push(email);
        return true;
      },
      addAccountViaOAuth: async () => null,
      probeCandidate: async (email: string) => {
        probedEmails.push(email);
        if (email === 'candidate1.stale@example.com') {
          // JIT Probe reveals candidate 1 was drained to 0% on another laptop/device!
          return {
            ok: true,
            isDepleted: true,
            fiveHourPercentage: 0,
            weeklyPercentage: 40,
            resetTime: '2026-10-19T18:00:00Z'
          };
        }
        if (email === 'candidate2.fresh@example.com') {
          // Candidate 2 is verified healthy
          return {
            ok: true,
            isDepleted: false,
            fiveHourPercentage: 70,
            weeklyPercentage: 70
          };
        }
        return { ok: false, isDepleted: true };
      },
      onCandidateDepletedExternally: async (email: string, probeResult: any) => {
        const idx = accounts.findIndex((a) => a.email === email);
        if (idx >= 0) {
          accounts[idx] = {
            ...accounts[idx],
            fiveHourQuotaPercentage: probeResult.fiveHourPercentage,
            averageQuotaPercentage: probeResult.fiveHourPercentage,
            externalActivityDetected: true,
            lastVerifiedSource: 'jit_guard'
          };
        }
      }
    };

    const autoSwitcher = new AccountAutoSwitcher(mockStorage as any, ctx as any);
    await autoSwitcher.checkAutoSwitch();

    // Verify JIT Probe checked Candidate 1 first
    assert.ok(probedEmails.includes('candidate1.stale@example.com'));

    // Candidate 1 was depleted externally, so switchAccount was NOT called for candidate 1!
    assert.strictEqual(switchedEmails.includes('candidate1.stale@example.com'), false);

    // Candidate 1 was marked as externally depleted
    const c1 = accounts.find((a) => a.email === 'candidate1.stale@example.com');
    assert.strictEqual(c1?.externalActivityDetected, true);
    assert.strictEqual(c1?.fiveHourQuotaPercentage, 0);

    // Verify candidate 2 was probed and successfully switched to!
    assert.ok(probedEmails.includes('candidate2.fresh@example.com'));
    assert.strictEqual(switchedEmails[0], 'candidate2.fresh@example.com');
  });

  it('Dynamic Demotion: demotes Candidate 1 when probed quota drops below Candidate 2 even if not depleted', async () => {
    let activeAcc = makeAutoSwitchAccount('active.depleted@example.com', 2, true);
    let candidate1 = makeAutoSwitchAccount('candidate1.top@example.com', 95, false);
    let candidate2 = makeAutoSwitchAccount('candidate2.steady@example.com', 85, false);

    let accounts = [activeAcc, candidate1, candidate2];
    const probedEmails: string[] = [];
    const switchedEmails: string[] = [];

    const mockStorage = {
      getAutoSwitchEnabled: () => true,
      getAutoSwitchTarget: () => 'instant',
      getAutoSwitchThreshold: () => 5,
      renewRefreshLease: () => {},
      saveAccounts: async () => {}
    };

    const ctx = {
      getAccounts: () => accounts,
      getActiveAccount: () => activeAcc,
      switchAccount: async (email: string) => {
        switchedEmails.push(email);
        return true;
      },
      addAccountViaOAuth: async () => null,
      probeCandidate: async (email: string) => {
        probedEmails.push(email);
        if (email === 'candidate1.top@example.com') {
          // Probe reveals candidate 1 is NOT depleted (it has 60%), but 60% is lower than Candidate 2 (85%)!
          return {
            ok: true,
            isDepleted: false,
            fiveHourPercentage: 60,
            weeklyPercentage: 80,
            resetTime: '2026-10-19T20:00:00Z'
          };
        }
        if (email === 'candidate2.steady@example.com') {
          // Candidate 2 is steady at 85%
          return {
            ok: true,
            isDepleted: false,
            fiveHourPercentage: 85,
            weeklyPercentage: 85
          };
        }
        return { ok: false, isDepleted: true };
      },
      onCandidateProbed: async (email: string, probeResult: any) => {
        const idx = accounts.findIndex((a) => a.email === email);
        if (idx >= 0) {
          accounts[idx] = {
            ...accounts[idx],
            fiveHourQuotaPercentage: probeResult.fiveHourPercentage,
            weeklyQuotaPercentage: probeResult.weeklyPercentage,
            averageQuotaPercentage: probeResult.fiveHourPercentage,
            quotas: accounts[idx].quotas.map((q) =>
              q.windowType === '5h' ? { ...q, percentage: probeResult.fiveHourPercentage } : q
            ),
            lastVerifiedSource: 'jit_guard'
          };
        }
      }
    };

    const autoSwitcher = new AccountAutoSwitcher(mockStorage as any, ctx as any);
    await autoSwitcher.checkAutoSwitch();

    // Verify Candidate 1 was probed first because its initial quota was 95% > 85%
    assert.strictEqual(probedEmails[0], 'candidate1.top@example.com');

    // Candidate 1 was demoted because 60% < Candidate 2's 85%
    // Auto-switch switched to Candidate 2, NOT Candidate 1!
    assert.strictEqual(switchedEmails[0], 'candidate2.steady@example.com');
    assert.strictEqual(switchedEmails.includes('candidate1.top@example.com'), false);
  });

  it('QuotaApiClient routes all accounts (active and standby) directly to Google Cloud Code PA without agy', async () => {
    const { QuotaApiClient } = require('../src/quota/quotaApiClient');

    const mockDirectClient = new GoogleDirectApiClient();
    let directCalledCount = 0;
    mockDirectClient.fetchStandbyQuota = async () => {
      directCalledCount++;
      return {
        response: {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                {
                  bucketId: 'gemini-5h',
                  displayName: 'Five Hour Limit Remaining',
                  remainingFraction: 0.76,
                  resetTime: '2026-11-12T23:13:08Z'
                }
              ]
            }
          ]
        },
        models: {
          'gemini-2.5-flash': { displayName: 'Gemini 2.5 Flash', quotaInfo: { remainingFraction: 0.76, resetTime: '2026-11-12T23:13:08Z' } }
        },
        paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' }
      };
    };

    const apiClient = new QuotaApiClient(undefined, mockDirectClient);

    // Active account: queries Google direct API directly
    const activeRes = await apiClient.fetchLiveQuotaData('test_token', true, 'active.dev@gmail.com');
    assert.strictEqual(directCalledCount, 1);
    const geminiGrp = activeRes.response.groups.find((g: any) => g.displayName === 'Gemini Models');
    assert.ok(geminiGrp);
    const b5h = geminiGrp.buckets.find((b: any) => b.bucketId === 'gemini-5h');
    assert.ok(b5h);
    assert.strictEqual(b5h.remainingFraction, 0.76);

    // Standby account (isActiveAccount = false): also routes directly to Google direct API
    await apiClient.fetchLiveQuotaData('test_token', false, 'standby.dev@gmail.com');
    assert.strictEqual(directCalledCount, 2);
  });

  it('getIdeRuntimeMetadata resolves modern lsVersion from daemon hub json and avoids legacy <2.x User-Agent', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { getIdeRuntimeMetadata } = require('../src/quota/ideRuntimeMetadata');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-meta-'));
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'hub_54007.json'),
        JSON.stringify({ pid: 1234, httpPort: 54007, httpsPort: 54009, lsVersion: '2.38.4', csrfToken: 'abc-123' }),
        'utf8'
      );
      const meta = getIdeRuntimeMetadata(tmpDir);
      assert.strictEqual(meta.ideVersion, '2.38.4');
      assert.ok(meta.userAgent.startsWith('antigravity/2.38.4 '), `Unexpected User-Agent: ${meta.userAgent}`);

      const fallbackMeta = getIdeRuntimeMetadata(path.join(tmpDir, 'nonexistent'));
      assert.strictEqual(fallbackMeta.ideVersion, '2.35.1');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('parseAgyHubCommandLines reads csrfToken from daemon hub_<port>.json when --csrf_token is omitted', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { parseAgyHubCommandLines } = require('../src/quota/ideLocalAgyClient');

    const tmpGeminiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-daemon-'));
    try {
      const daemonDir = path.join(tmpGeminiDir, 'antigravity', 'daemon');
      fs.mkdirSync(daemonDir, { recursive: true });
      fs.writeFileSync(
        path.join(daemonDir, 'hub_54007.json'),
        JSON.stringify({ pid: 18524, httpPort: 54007, httpsPort: 54009, lsVersion: '2.35.1', csrfToken: 'test-csrf-token-54007' }),
        'utf8'
      );

      const hubs = parseAgyHubCommandLines(
        ['C:\\Users\\dev\\.gemini\\bin\\agy.exe --hub --hub-port=54007 --app_data_dir=antigravity --add-dir=C:\\repo'],
        tmpGeminiDir
      );
      assert.strictEqual(hubs.length, 1);
      assert.strictEqual(hubs[0].port, 54007);
      assert.strictEqual(hubs[0].csrfToken, 'test-csrf-token-54007');
      assert.strictEqual(hubs[0].lsVersion, '2.35.1');
    } finally {
      fs.rmSync(tmpGeminiDir, { recursive: true, force: true });
    }
  });

  it('enrichQuotaGroupsWithModels preserves authoritative gemini-weekly even when derivedWeeklyFrom5h is lower or higher', () => {
    const { enrichQuotaGroupsWithModels } = require('../src/quota/googleDirectApiClient');
    const future5h = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    const futureWeekly = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();

    const groups = [
      {
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.45, resetTime: futureWeekly },
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.92, resetTime: future5h }
        ]
      }
    ];
    // Flash 5h dropped to 0.10 -> derivedWeeklyFrom5h = 1 - 0.9/3.5 = 0.742 (higher than 0.45),
    // and what if 5h is 0.0 -> derivedWeeklyFrom5h = 0.714; now test 0.90 in UQS vs 0.10 5h:
    const modelsData = {
      'gemini-3.8-flash-tiered': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.92, resetTime: future5h } }
    };

    const enriched = enrichQuotaGroupsWithModels(groups, modelsData, false, false);
    const gemini = enriched.find((g: any) => g.displayName === 'Gemini Models');
    const wk = gemini.buckets.find((b: any) => b.bucketId === 'gemini-weekly');
    assert.strictEqual(wk.remainingFraction, 0.45);

    // Also test authoritative 0.90 weekly is NOT overwritten by lower synthetic derivedWeeklyFrom5h (0.714) when 5h=0
    const groups2 = [
      {
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.90, resetTime: futureWeekly },
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.0, resetTime: future5h }
        ]
      }
    ];
    const modelsData2 = {
      'gemini-3.8-flash-tiered': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.0, resetTime: future5h } }
    };
    const enriched2 = enrichQuotaGroupsWithModels(groups2, modelsData2, false, false);
    const gemini2 = enriched2.find((g: any) => g.displayName === 'Gemini Models');
    const wk2 = gemini2.buckets.find((b: any) => b.bucketId === 'gemini-weekly');
    assert.strictEqual(wk2.remainingFraction, 0.90);
  });

  it('fetchActiveAccountQuotaFromIde reuses fresh shared cache across instances and invalidates on account change', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { fetchActiveAccountQuotaFromIde, getFreshSharedIdeQuotaCache } = require('../src/quota/ideLocalAgyClient');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-shared-cache-'));
    const cacheFilePath = path.join(tmpDir, '.ide-quota-cache.json');
    try {
      const mockResult = {
        email: 'active.user@example.com',
        geminiInstantPercentage: 25,
        claudeInstantPercentage: 100,
        accountInstantPercentage: 36,
        overallQuotaPercentage: 40,
        rawGroups: []
      };
      fs.writeFileSync(
        cacheFilePath,
        JSON.stringify({ email: 'active.user@example.com', timestamp: Date.now(), data: mockResult }),
        'utf8'
      );

      // 1. Fresh cache hit returns immediately without calling agy.exe
      const hit = await fetchActiveAccountQuotaFromIde(2500, true, {
        expectedEmail: 'active.user@example.com',
        cacheTtlMs: 25000,
        cacheFilePath
      });
      assert.ok(hit);
      assert.strictEqual(hit.email, 'active.user@example.com');
      assert.strictEqual(hit.geminiInstantPercentage, 25);

      // 2. Different expectedEmail invalidates cache hit
      const mismatch = getFreshSharedIdeQuotaCache({
        expectedEmail: 'other.user@example.com',
        cacheTtlMs: 25000,
        cacheFilePath
      });
      assert.strictEqual(mismatch, null);

      // 3. bypassSharedCache ignores cache
      const bypassed = getFreshSharedIdeQuotaCache({
        expectedEmail: 'active.user@example.com',
        cacheTtlMs: 25000,
        cacheFilePath,
        bypassSharedCache: true
      });
      assert.strictEqual(bypassed, null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('tryAcquireIdeQuotaLock enforces exclusive locking and self-recovers from dead PID or expired TTL', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { tryAcquireIdeQuotaLock, releaseIdeQuotaLock } = require('../src/quota/ideLocalAgyClient');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-lock-'));
    const lockPath = path.join(tmpDir, '.ide-quota-cache.json.lock');
    try {
      // 1. Live process (process.pid) holds valid lock -> second contender must fail (preventing race condition)
      const acq1 = tryAcquireIdeQuotaLock(lockPath, 10000, process.pid);
      assert.strictEqual(acq1, true);
      const acq2 = tryAcquireIdeQuotaLock(lockPath, 10000, process.pid + 1);
      assert.strictEqual(acq2, false, 'Must reject second contender while live PID holds non-expired lock');

      // 2. Release by non-owner PID must NOT delete owner lock
      releaseIdeQuotaLock(lockPath, process.pid + 1);
      assert.strictEqual(fs.existsSync(lockPath), true);

      // Release by owner PID removes lock
      releaseIdeQuotaLock(lockPath, process.pid);
      assert.strictEqual(fs.existsSync(lockPath), false);

      // 3. Dead-PID self-recovery: simulate crashed/closed IDE instance leaving orphaned lock with future expiresAt
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, expiresAt: Date.now() + 60000 }), 'utf8');
      const recoveredDead = tryAcquireIdeQuotaLock(lockPath, 5000, process.pid);
      assert.strictEqual(recoveredDead, true, 'Must self-recover immediately when lock owner PID is dead');

      // 4. Expired TTL recovery even if PID is alive
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, expiresAt: Date.now() - 1000 }), 'utf8');
      const recoveredExpired = tryAcquireIdeQuotaLock(lockPath, 5000, process.pid + 2);
      assert.strictEqual(recoveredExpired, true, 'Must self-recover when lock TTL is expired');

      releaseIdeQuotaLock(lockPath, process.pid + 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
