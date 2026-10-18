import test from 'node:test';
import assert from 'node:assert';
import type { AccountAutoSwitcherContext } from '../src/account/accountAutoSwitcher';
import { AccountInfo } from '../src/types';

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


function createMockAccount(
  id: string,
  email: string,
  name: string,
  tier: 'PRO' | 'STANDARD FREE',
  geminiQuota: number,
  isActive = false
): AccountInfo {
  const isFree = tier === 'STANDARD FREE';
  return {
    id,
    email,
    name,
    isActive,
    status: 'healthy',
    accountType: isFree ? 'Standard Free' : 'Google AI Pro',
    tierBadge: tier,
    has5HourQuota: !isFree,
    hasWeeklyQuota: true,
    fiveHourQuotaPercentage: isFree ? undefined : geminiQuota,
    weeklyQuotaPercentage: geminiQuota,
    averageQuotaPercentage: geminiQuota,
    lastRefreshedAt: new Date().toISOString(),
    geminiGroup: {
      id: 'gemini',
      name: 'Gemini Models',
      fiveHour: isFree ? undefined : {
        bucketId: 'gemini-5h',
        displayName: '5 Hour Limit Remaining',
        window: '5h',
        percentage: geminiQuota,
        remainingFraction: geminiQuota / 100
      },
      weekly: {
        bucketId: 'gemini-weekly',
        displayName: 'Weekly Limit Remaining',
        window: 'weekly',
        percentage: geminiQuota,
        remainingFraction: geminiQuota / 100
      },
      buckets: [
        {
          bucketId: 'gemini-weekly',
          displayName: 'Weekly Limit Remaining',
          window: 'weekly',
          percentage: geminiQuota,
          remainingFraction: geminiQuota / 100
        }
      ]
    },
    quotas: [
      {
        id: `${id}-pro`,
        displayName: 'Gemini 3.1 Pro',
        groupName: 'Gemini Models',
        percentage: geminiQuota,
        remainingFraction: geminiQuota / 100,
        windowType: 'weekly',
        windowLabel: 'Weekly Plan Quota',
        disabled: false
      }
    ]
  };
}

test('Comprehensive Auto-Switch Domino Depletion Cascade', async (t) => {
  let accounts: AccountInfo[] = [
    createMockAccount('acc-1', 'account1@example.com', 'Account 1', 'PRO', 80, true),
    createMockAccount('acc-2', 'account2@example.com', 'Account 2', 'PRO', 65, false),
    createMockAccount('acc-3', 'account3@example.com', 'Account 3', 'PRO', 45, false),
    createMockAccount('acc-4', 'account4@example.com', 'Account 4', 'STANDARD FREE', 20, false)
  ];

  const switchHistory: Array<{ from: string; to: string }> = [];

  const mockStorage: any = {
    getAutoSwitchEnabled: () => true,
    getAutoSwitchThreshold: () => 5, // Threshold = 5%
    getAutoSwitchTarget: () => 'gemini'
  };

  const mockCtx: AccountAutoSwitcherContext = {
    getAccounts: () => accounts,
    getActiveAccount: () => accounts.find((a) => a.isActive),
    switchAccount: async (email: string) => {
      const prev = accounts.find((a) => a.isActive)?.email || '';
      accounts = accounts.map((a) => ({
        ...a,
        isActive: a.email.toLowerCase() === email.toLowerCase()
      }));
      switchHistory.push({ from: prev, to: email });
      return true;
    },
    addAccountViaOAuth: async () => null
  };

  const autoSwitcher = new AccountAutoSwitcher(mockStorage, mockCtx);

  const burnActiveQuota = (newQuota: number) => {
    const active = accounts.find((a) => a.isActive);
    if (!active) return;
    const isFree = active.tierBadge === 'STANDARD FREE';
    if (!isFree) {
      active.fiveHourQuotaPercentage = newQuota;
      if (active.geminiGroup?.fiveHour) {
        active.geminiGroup.fiveHour.percentage = newQuota;
        active.geminiGroup.fiveHour.remainingFraction = newQuota / 100;
      }
    }
    active.weeklyQuotaPercentage = newQuota;
    if (active.geminiGroup?.weekly) {
      active.geminiGroup.weekly.percentage = newQuota;
      active.geminiGroup.weekly.remainingFraction = newQuota / 100;
    }
    const q = active.quotas?.[0];
    if (q) {
      q.percentage = newQuota;
      q.remainingFraction = newQuota / 100;
    }
  };

  await t.test('Initial state: Account 1 is active with 80% quota', () => {
    const active = mockCtx.getActiveAccount();
    assert.strictEqual(active?.email, 'account1@example.com');
    assert.strictEqual(autoSwitcher.getAccountTargetQuota(active, 'gemini'), 80);
  });

  await t.test('Burn Step 1: Account 1 drops to 4% (<= 5% threshold) -> switches to Account 2 (65%)', async () => {
    burnActiveQuota(4);
    await autoSwitcher.checkAutoSwitch();

    const active = mockCtx.getActiveAccount();
    assert.strictEqual(active?.email, 'account2@example.com', 'Should switch to highest candidate Account 2');
    assert.strictEqual(switchHistory[switchHistory.length - 1].to, 'account2@example.com');
    assert.strictEqual(autoSwitcher.getAccountTargetQuota(active, 'gemini'), 65);
  });

  await t.test('Burn Step 2: Account 2 drops to 3% (<= 5%) -> switches to Account 3 (45%)', async () => {
    burnActiveQuota(3);
    await autoSwitcher.checkAutoSwitch();

    const active = mockCtx.getActiveAccount();
    assert.strictEqual(active?.email, 'account3@example.com', 'Should switch to next highest candidate Account 3');
    assert.strictEqual(switchHistory[switchHistory.length - 1].to, 'account3@example.com');
    assert.strictEqual(autoSwitcher.getAccountTargetQuota(active, 'gemini'), 45);
  });

  await t.test('Burn Step 3: Account 3 drops to 2% (<= 5%) -> switches to Account 4 (20%)', async () => {
    burnActiveQuota(2);
    await autoSwitcher.checkAutoSwitch();

    const active = mockCtx.getActiveAccount();
    assert.strictEqual(active?.email, 'account4@example.com', 'Should switch to last remaining healthy Account 4');
    assert.strictEqual(switchHistory[switchHistory.length - 1].to, 'account4@example.com');
    assert.strictEqual(autoSwitcher.getAccountTargetQuota(active, 'gemini'), 20);
  });

  await t.test('Burn Step 4: Account 4 drops to 1% (<= 5%) -> No standby accounts remain, handles gracefully', async () => {
    const prevHistoryLen = switchHistory.length;
    burnActiveQuota(1);
    await autoSwitcher.checkAutoSwitch();

    const active = mockCtx.getActiveAccount();
    assert.strictEqual(active?.email, 'account4@example.com', 'Should stay on Account 4 as no healthy standby accounts exist');
    assert.strictEqual(switchHistory.length, prevHistoryLen, 'No further switch should occur');

    // Verify error notification was fired
    const errorEvent = ideEvents.find((e) => e.type === 'error' && e.msg.includes('No healthy standby accounts available'));
    assert.ok(errorEvent, 'Should notify user that no healthy standby accounts remain');
  });

  await t.test('Verify full domino switch trajectory', () => {
    assert.strictEqual(switchHistory.length, 3, 'Should have executed exactly 3 switches');
    assert.deepStrictEqual(switchHistory, [
      { from: 'account1@example.com', to: 'account2@example.com' },
      { from: 'account2@example.com', to: 'account3@example.com' },
      { from: 'account3@example.com', to: 'account4@example.com' }
    ]);
  });
});

test('Candidate Switch Failure Fallback (Max 2 Attempts)', async (t) => {
  let accounts: AccountInfo[] = [
    createMockAccount('acc-active', 'active@example.com', 'Active Account', 'PRO', 2, true), // depleted (2% <= 5%)
    createMockAccount('acc-cand1', 'cand1@example.com', 'Candidate 1', 'PRO', 90, false),   // top candidate
    createMockAccount('acc-cand2', 'cand2@example.com', 'Candidate 2', 'PRO', 80, false),   // second candidate
    createMockAccount('acc-cand3', 'cand3@example.com', 'Candidate 3', 'PRO', 70, false)    // third candidate
  ];

  const switchAttempts: string[] = [];
  const mockStorage: any = {
    getAutoSwitchEnabled: () => true,
    getAutoSwitchThreshold: () => 5,
    getAutoSwitchTarget: () => 'gemini'
  };

  await t.test('Scenario 1: Candidate 1 fails (transient), Candidate 2 succeeds immediately', async () => {
    const mockCtx: AccountAutoSwitcherContext = {
      getAccounts: () => accounts,
      getActiveAccount: () => accounts.find((a) => a.isActive),
      switchAccount: async (email: string) => {
        switchAttempts.push(email);
        if (email === 'cand1@example.com') {
          // Cand 1 fails (transient network glitch)
          const c1 = accounts.find((a) => a.email === email);
          if (c1) c1.statusMessage = 'Switch failed: Network timeout';
          return false;
        }
        // Cand 2 succeeds
        accounts = accounts.map((a) => ({
          ...a,
          isActive: a.email.toLowerCase() === email.toLowerCase()
        }));
        return true;
      },
      addAccountViaOAuth: async () => null
    };

    const autoSwitcher = new AccountAutoSwitcher(mockStorage, mockCtx);
    await autoSwitcher.checkAutoSwitch();

    assert.deepStrictEqual(switchAttempts, ['cand1@example.com', 'cand2@example.com'], 'Should have attempted cand1 then cand2');
    const active = mockCtx.getActiveAccount();
    assert.strictEqual(active?.email, 'cand2@example.com', 'Active account should now be Candidate 2');
    assert.strictEqual(accounts.find((a) => a.email === 'cand1@example.com')?.statusMessage, 'Switch failed: Network timeout');
  });

  await t.test('Scenario 2: Both Candidate 1 and Candidate 2 fail -> stops searching at 2 attempts, stays on active account', async () => {
    // Reset accounts with active at 2%
    accounts = [
      createMockAccount('acc-active', 'active@example.com', 'Active Account', 'PRO', 2, true),
      createMockAccount('acc-cand1', 'cand1@example.com', 'Candidate 1', 'PRO', 90, false),
      createMockAccount('acc-cand2', 'cand2@example.com', 'Candidate 2', 'PRO', 80, false),
      createMockAccount('acc-cand3', 'cand3@example.com', 'Candidate 3', 'PRO', 70, false)
    ];

    const attemptsHistory: string[] = [];
    const mockCtx: AccountAutoSwitcherContext = {
      getAccounts: () => accounts,
      getActiveAccount: () => accounts.find((a) => a.isActive),
      switchAccount: async (email: string) => {
        attemptsHistory.push(email);
        const c = accounts.find((a) => a.email === email);
        if (c) c.statusMessage = `Switch failed for ${email}`;
        return false; // All fail
      },
      addAccountViaOAuth: async () => null
    };

    let leaseRenewCalls = 0;
    const mockStorageWithLeaseSpy: any = {
      ...mockStorage,
      renewRefreshLease: () => { leaseRenewCalls++; }
    };

    const autoSwitcher = new AccountAutoSwitcher(mockStorageWithLeaseSpy, mockCtx);
    await autoSwitcher.checkAutoSwitch();

    // Must have attempted cand1, then cand2, and STOPPED without touching cand3
    assert.deepStrictEqual(attemptsHistory, ['cand1@example.com', 'cand2@example.com']);
    const active = mockCtx.getActiveAccount();
    assert.strictEqual(active?.email, 'active@example.com', 'Must stay on current account after 2 failed attempts');
    assert.ok(leaseRenewCalls >= 2, `Expected distributed lease to be renewed at least twice, got ${leaseRenewCalls}`);
  });
});

