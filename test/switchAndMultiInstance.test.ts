import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AccountInfo, OAuthTokens, ModelQuota } from '../src/types';

// MUST mock vscode before local modules importing vscode are loaded via require
const Module = require('module');
const origRequire = Module.prototype.require;

const executedCommands: string[] = [];
const pushedUpdates: any[] = [];
let mockOAuthTokenInfo: any = null;

const mockVscode = {
  EventEmitter: class {
    private listeners: Function[] = [];
    event = (listener: Function) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire = (data: any) => {
      this.listeners.forEach((l) => l(data));
    };
  },
  window: {
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    onDidChangeWindowState: () => ({ dispose: () => {} }),
    activeColorTheme: { kind: 2 }
  },
  commands: {
    getCommands: async () => [
      'antigravity.handleAuthRefresh',
      'antigravity.reconnect',
      'antigravity.internal.getAuthStatus'
    ],
    executeCommand: async (cmd: string, ...args: any[]) => {
      executedCommands.push(cmd);
      if (cmd === 'antigravity.internal.getAuthStatus') {
        return { hasValidAuth: true };
      }
      return undefined;
    }
  },
  antigravityUnifiedStateSync: {
    UserStatus: {
      getUserStatus: async () => ''
    },
    OAuthPreferences: {
      setOAuthTokenInfo: async (info: any) => {
        mockOAuthTokenInfo = info;
      }
    },
    pushUpdate: async (update: any) => {
      pushedUpdates.push(update);
    }
  }
};

Module.prototype.require = function (id: string, ...args: any[]) {
  if (id === 'vscode') {
    return mockVscode;
  }
  return origRequire.apply(this, [id, ...args]);
};

const { UssHotSwitchService } = require('../src/storage/ussHotSwitch');
const { DistributedSyncManager } = require('../src/storage/distributedSync');

function createMockAccount(email: string, overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id: Buffer.from(email).toString('base64').substring(0, 16),
    email,
    name: email.split('@')[0],
    isActive: true,
    status: 'healthy',
    accountType: 'Google AI Pro',
    tierBadge: 'PRO',
    addedAt: new Date().toISOString(),
    quotas: [],
    hasWeeklyQuota: true,
    has5HourQuota: true,
    ...overrides
  };
}

describe('Account Switch and Multi-Instance Sync Suite', () => {
  it('UssHotSwitchService never calls internal.logout and pushes signedIn authState', async () => {
    executedCommands.length = 0;
    pushedUpdates.length = 0;
    mockOAuthTokenInfo = null;

    const service = new UssHotSwitchService();
    const account: AccountInfo = createMockAccount('active.switch@example.com', { name: 'Active Switch' });
    const tokens: OAuthTokens = {
      accessToken: 'ya29.mock_switch_token',
      refreshToken: '1//mock_refresh',
      expiresAt: Date.now() + 3600000
    };

    const result = await service.liveSwitchOAuthToken(account, tokens, true);

    // 1. Must never execute antigravity.internal.logout
    assert.strictEqual(
      executedCommands.includes('antigravity.internal.logout'),
      false,
      'antigravity.internal.logout MUST NOT be called as it destroys chat session'
    );

    // 2. Must never execute antigravity.internal.getAuthStatus (causes LS to clear project/tier and invalidate session)
    assert.strictEqual(
      executedCommands.includes('antigravity.internal.getAuthStatus'),
      false,
      'antigravity.internal.getAuthStatus MUST NOT be triggered as it clears project/tier in LS and invalidates session'
    );
    assert.strictEqual(
      executedCommands.includes('antigravity.handleAuthRefresh'),
      true,
      'antigravity.handleAuthRefresh should be triggered'
    );

    // 3. Must push signedIn authState to uss-oauth
    const authStateUpdate = pushedUpdates.find(
      (u: any) => u.topicName === 'uss-oauth' && u.appliedUpdate?.key === 'authStateWithContextSentinelKey'
    );
    assert.ok(authStateUpdate, 'Must push authStateWithContextSentinelKey');
    const parsedState = JSON.parse(authStateUpdate.appliedUpdate.newRow.value);
    assert.strictEqual(parsedState.state, 'signedIn');
  });

  it('DistributedSyncManager broadcasts switch event and detects external switch', () => {
    let externalSwitchReceived: any = null;
    let externalAccountsChanged = 0;

    const mockSecrets: any = {
      onDidChange: () => ({ dispose: () => {} })
    };

    const tmpDir = path.join(os.homedir(), '.antigravity-swap');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    const accountsFile = path.join(tmpDir, 'accounts.json');

    const manager = new DistributedSyncManager(
      mockSecrets,
      () => {
        externalAccountsChanged++;
      },
      () => {},
      (data: any) => {
        externalSwitchReceived = data;
      },
      () => 0,
      () => accountsFile
    );

    // Test switch event broadcast
    manager.broadcastSwitchCompleted('switched.user@example.com');
    const switchFile = manager.getSwitchEventFilePath();
    assert.strictEqual(fs.existsSync(switchFile), true, 'Switch event file must exist');

    const content = JSON.parse(fs.readFileSync(switchFile, 'utf-8'));
    assert.strictEqual(content.email, 'switched.user@example.com');

    // Simulate external process switch event
    content.pid = process.pid + 999; // Different PID (different instance)
    content.timestamp = Date.now();
    fs.writeFileSync(switchFile, JSON.stringify(content), 'utf-8');

    manager.checkExternalSwitchEvent();
    assert.ok(externalSwitchReceived, 'Must detect external switch event');
    assert.strictEqual(externalSwitchReceived.email, 'switched.user@example.com');
  });

  it('UssHotSwitchService with skipKeyring=true succeeds and updates USS without touching keyring', async () => {
    executedCommands.length = 0;
    pushedUpdates.length = 0;
    mockOAuthTokenInfo = null;

    const service = new UssHotSwitchService();
    const account: AccountInfo = createMockAccount('multi.instance@example.com', { name: 'Multi Instance' });
    const tokens: OAuthTokens = {
      accessToken: 'ya29.multi_instance_token',
      refreshToken: '1//multi_instance_refresh',
      expiresAt: Date.now() + 3600000
    };

    const result = await service.liveSwitchOAuthToken(account, tokens, true);
    assert.strictEqual(result, true, 'Hot switch with skipKeyring must succeed');
    assert.strictEqual(mockOAuthTokenInfo.accessToken, 'ya29.multi_instance_token');
    assert.strictEqual(executedCommands.includes('antigravity.handleAuthRefresh'), true);
  });

  it('AccountQuotaSync proactively refreshes active token near expiration and syncs IDE', async () => {
    let savedTokens: any = null;
    let liveSwitchedAccount: any = null;
    let syncedIdeAccount: any = null;
    let refreshCount = 0;

    const mockStorage: any = {
      tryAcquireRefreshLease: () => false, // simulate lease held by other tick
      getAccountTokens: async () => ({
        accessToken: 'ya29.old_expiring_token',
        refreshToken: '1//valid_refresh',
        expiresAt: Date.now() + 2 * 60 * 1000 // expiring in 2m (< 10m threshold)
      }),
      saveAccountTokens: async (email: string, tokens: any) => {
        savedTokens = tokens;
      },
      liveSwitchOAuthToken: async (acc: any, tokens: any) => {
        liveSwitchedAccount = acc;
      },
      syncToIdeStateDb: async (acc: any, tokens: any) => {
        syncedIdeAccount = acc;
      }
    };

    const mockQuotaService: any = {
      refreshAccessToken: async () => {
        refreshCount++;
        return {
          accessToken: 'ya29.brand_new_proactive_token',
          refreshToken: '1//valid_refresh',
          expiresAt: Date.now() + 3600 * 1000,
          tokenType: 'Bearer'
        };
      }
    };

    const activeAcc: AccountInfo = createMockAccount('proactive.test@example.com', { name: 'Proactive Test' });

    const { AccountQuotaSync } = require('../src/account/accountQuotaSync');
    const sync = new AccountQuotaSync(mockStorage, mockQuotaService, {
      getAccounts: () => [activeAcc],
      setAccounts: () => {},
      getActiveAccount: () => activeAcc,
      reloadFromStorage: async () => {},
      checkAutoSwitch: async () => {},
      checkExternalIdeSession: async () => {},
      notifyStateChange: () => {}
    });

    await sync.runHeartbeatTick();

    assert.strictEqual(refreshCount, 1, 'Must proactively refresh token nearing expiration');
    assert.ok(savedTokens, 'Must save refreshed tokens');
    assert.strictEqual(savedTokens.accessToken, 'ya29.brand_new_proactive_token');
    assert.strictEqual(liveSwitchedAccount.email, 'proactive.test@example.com');
    assert.strictEqual(syncedIdeAccount.email, 'proactive.test@example.com');
  });

  it('UssHotSwitchService overrides agentOnboardingCompleted=2 permanently to allow agent execution', async () => {
    // Build a realistic UserStatus proto payload (>50 bytes) with agentOnboardingCompleted = 0 (field 5)
    // Using pre-computed base64 of a 76-byte payload:
    // field1(pro=1), field3(name="Previous User"), field5(agentOnboarding=0),
    // field7(email="prev@example.com"), field31(has_used=1), field34(accepted_tos=1), field26(avatarUrl)
    const userStatusWithOnboarding0 = 'CAEaDVByZXZpb3VzIFVzZXIoADoQcHJldkBleGFtcGxlLmNvbfgBAZACAdIBHmh0dHBzOi8vZXhhbXBsZS5jb20vYXZhdGFyLnBuZw==';

    const localPushedUpdates: any[] = [];

    // Override global mockVscode USS properties directly (module already references mockVscode via require mock)
    const originalGetUserStatus = mockVscode.antigravityUnifiedStateSync.UserStatus.getUserStatus;
    const originalPushUpdate = mockVscode.antigravityUnifiedStateSync.pushUpdate;
    mockVscode.antigravityUnifiedStateSync.UserStatus.getUserStatus = async () => userStatusWithOnboarding0;
    mockVscode.antigravityUnifiedStateSync.pushUpdate = async (update: any) => {
      localPushedUpdates.push(update);
    };

    try {
      const service = new UssHotSwitchService();
      const acc: AccountInfo = createMockAccount('ftue.test@example.com', { name: 'FTUE Test' });
      const toks: OAuthTokens = { accessToken: 'ya29.ftue_tok', refreshToken: '1//ftue', expiresAt: Date.now() + 3600000 };

      await service.liveSwitchOAuthToken(acc, toks, true);

      // 1. pushUpdate to uss-userStatus must have agentOnboardingCompleted = 2 (COMPLETED) in Antigravity IDE 2.7
      const userStatusUpdate = localPushedUpdates.find(
        (u: any) => u.topicName === 'uss-userStatus' && u.appliedUpdate?.key === 'userStatusSentinelKey'
      );
      assert.ok(userStatusUpdate, 'Must push userStatus update during switch');

      const patchedBytes = Buffer.from(userStatusUpdate.appliedUpdate.newRow.value, 'base64');
      const { parseProtoFields } = require('../src/storage/protoUtils');
      const fields = parseProtoFields(patchedBytes);
      const field5 = fields.find((f: any) => f.fieldNum === 5 && f.wireType === 0);
      assert.ok(field5, 'Patched userStatus must contain field 5 (agentOnboardingCompleted)');
      assert.strictEqual(Number(field5.data), 2, 'agentOnboardingCompleted must be set to 2 permanently (COMPLETED enum in IDE 2.7)');

      // 2. Must push uss-onboardingState with agentOnboardingStateSentinelKey = EAI= (COMPLETED)
      const onboardingUpdate = localPushedUpdates.find(
        (u: any) => u.topicName === 'uss-onboardingState' && u.appliedUpdate?.key === 'agentOnboardingStateSentinelKey'
      );
      assert.ok(onboardingUpdate, 'Must push uss-onboardingState during switch');
      assert.strictEqual(onboardingUpdate.appliedUpdate.newRow.value, 'EAI=', 'agentOnboardingState value must be EAI= (COMPLETED)');
    } finally {
      mockVscode.antigravityUnifiedStateSync.UserStatus.getUserStatus = originalGetUserStatus;
      mockVscode.antigravityUnifiedStateSync.pushUpdate = originalPushUpdate;
    }
  });

  it('UssHotSwitchService syncCoreExtensionStorage updates in-memory google.google-antigravity state', async () => {
    let capturedSetValue: { shared: boolean; key: string; value: any } | null = null;
    const mockStorage = {
      initializeExtensionStorage: async (shared: boolean, key: string, defVal: any) => ({
        'antigravity-storage': {
          'agy.onboarding.lastLoginUsername': 'old@example.com',
          'jetski.onboarding.lastLoginUsername': 'old@example.com'
        }
      }),
      setValue: async (shared: boolean, key: string, value: any) => {
        capturedSetValue = { shared, key, value };
      }
    };

    const mockContext = {
      globalState: {
        _storage: mockStorage
      }
    } as any;

    const service = new UssHotSwitchService(mockContext);
    const targetEmail = 'new.user@example.com';

    const ok = await service.syncCoreExtensionStorage(targetEmail);
    assert.strictEqual(ok, true, 'syncCoreExtensionStorage should return true');
    assert.ok(capturedSetValue, 'setValue should be called on mockStorage');
    assert.strictEqual((capturedSetValue as any).shared, true, 'Must target global storage (shared: true)');
    assert.strictEqual((capturedSetValue as any).key, 'google.google-antigravity', 'Must target google.google-antigravity extension ID');

    const agyStorage = (capturedSetValue as any).value['antigravity-storage'];
    assert.strictEqual(agyStorage['agy.onboarding.lastLoginUsername'], targetEmail);
    assert.strictEqual(agyStorage['agy.onboarding.lastLoginIsGcpTos'], 'false');
    assert.strictEqual(agyStorage['agy.onboarding.lastLoginStrategy'], 'google');
    assert.strictEqual(agyStorage['jetski.onboarding.lastLoginUsername'], targetEmail);
    assert.strictEqual(agyStorage['jetski.onboarding.lastLoginIsGcpTos'], 'false');
    assert.strictEqual(agyStorage['jetski.onboarding.lastLoginStrategy'], 'google');
  });

  it('liveSwitchOAuthToken with triggerReconnect=false suppresses antigravity.reconnect and preserves chat webview', async () => {
    executedCommands.length = 0;
    pushedUpdates.length = 0;

    const service = new UssHotSwitchService();
    const account: AccountInfo = createMockAccount('silent.refresh@example.com', { name: 'Silent Refresh' });
    const tokens: OAuthTokens = {
      accessToken: 'ya29.silent_refresh_token',
      refreshToken: '1//silent_refresh',
      expiresAt: Date.now() + 3600000
    };

    // When triggerReconnect = false and pushOnboarding = false (background token refresh of active account):
    const result = await service.liveSwitchOAuthToken(account, tokens, true, false, false);
    assert.strictEqual(result, true);

    // 1. MUST trigger antigravity.handleAuthRefresh quietly
    assert.strictEqual(
      executedCommands.includes('antigravity.handleAuthRefresh'),
      true,
      'antigravity.handleAuthRefresh MUST be called to update auth headers'
    );

    // 2. MUST NOT trigger antigravity.reconnect (which reloads the chat webview and shows loading screen)
    assert.strictEqual(
      executedCommands.includes('antigravity.reconnect'),
      false,
      'antigravity.reconnect MUST NOT be called on background token refresh'
    );

    // 3. MUST NOT push uss-onboardingState update when pushOnboarding=false
    const onboardingUpdate = pushedUpdates.find(
      (u: any) => u.topicName === 'uss-onboardingState'
    );
    assert.strictEqual(onboardingUpdate, undefined, 'uss-onboardingState must not be pushed on silent token refresh');
  });

  it('liveSwitchOAuthToken with pushOnboarding=true pushes uss-onboardingState COMPLETED on secondary window', async () => {
    executedCommands.length = 0;
    pushedUpdates.length = 0;

    const service = new UssHotSwitchService();
    const account: AccountInfo = createMockAccount('instance2.switched@example.com', { name: 'Instance 2 Switched' });
    const tokens: OAuthTokens = {
      accessToken: 'ya29.instance2_token',
      refreshToken: '1//instance2_refresh',
      expiresAt: Date.now() + 3600000
    };

    // When triggerReconnect = false but pushOnboarding = true (as in syncActiveAccountToCurrentWindow):
    const result = await service.liveSwitchOAuthToken(account, tokens, true, false, true);
    assert.strictEqual(result, true);

    // 1. MUST NOT call antigravity.reconnect (protecting chat streams)
    assert.strictEqual(
      executedCommands.includes('antigravity.reconnect'),
      false,
      'antigravity.reconnect must not be called'
    );

    // 2. MUST push uss-onboardingState with agentOnboardingState = COMPLETED (EAI=) to suppress chat dialog
    const onboardingUpdate = pushedUpdates.find(
      (u: any) => u.topicName === 'uss-onboardingState'
    );
    assert.ok(onboardingUpdate, 'uss-onboardingState MUST be pushed to suppress chat dialog');
    assert.strictEqual(
      onboardingUpdate.appliedUpdate.key,
      'agentOnboardingStateSentinelKey'
    );
    assert.strictEqual(
      onboardingUpdate.appliedUpdate.newRow.value,
      'EAI='
    );
  });

  it('New window instance startup immediately hydrates Unified State Sync for active account', async () => {
    executedCommands.length = 0;
    pushedUpdates.length = 0;
    mockOAuthTokenInfo = null;

    const service = new UssHotSwitchService();
    const activeAccount: AccountInfo = createMockAccount('instance2.active@example.com', { name: 'Instance Two User' });
    const activeTokens: OAuthTokens = {
      accessToken: 'ya29.instance2_boot_token',
      refreshToken: '1//instance2_refresh',
      expiresAt: Date.now() + 3600000
    };

    // Simulate window startup hydration (skipKeyring=true, triggerReconnect=true)
    const success = await service.liveSwitchOAuthToken(activeAccount, activeTokens, true, true);
    assert.strictEqual(success, true, 'Window startup hydration must succeed');

    // Verify token info populated in USS
    assert.strictEqual(mockOAuthTokenInfo.accessToken, 'ya29.instance2_boot_token');

    // Verify auth status refresh triggered
    assert.strictEqual(executedCommands.includes('antigravity.handleAuthRefresh'), true);
    assert.strictEqual(executedCommands.includes('antigravity.reconnect'), true);

    // Verify onboarding completed state pushed to avoid FTUE dialog
    const obUpdate = pushedUpdates.find((u: any) => u.topicName === 'uss-onboardingState');
    assert.ok(obUpdate, 'Must push onboardingState COMPLETED on startup');
  });

  it('AccountSwitcher prevents switching to accounts whose tokens lack aicode scope and marks needsReauth', async () => {
    const { AccountSwitcher } = require('../src/account/accountSwitcher');

    let savedAccounts: AccountInfo[] = [];
    const mockStorage: any = {
      getAccounts: () => [
        createMockAccount('missing.aicode@example.com', { name: 'Legacy User', isActive: false })
      ],
      getAccountTokens: async () => ({
        accessToken: 'ya29.legacy_token_without_aicode',
        refreshToken: '1//legacy_refresh',
        expiresAt: Date.now() + 3600000,
        hasAiCode: false // Lacks aicode scope
      }),
      saveAccounts: async (accs: AccountInfo[]) => { savedAccounts = accs; },
      saveAccountTokens: async () => {},
      renewRefreshLease: () => {},
      syncGoogleAccountsJson: async () => {},
      liveSwitchOAuthToken: async () => true,
      syncToIdeStateDb: async () => {},
      syncToCloudAccountsDb: async () => {},
      broadcastSwitchCompleted: () => {}
    };

    const mockOAuth: any = {
      refreshAccessToken: async () => ({ accessToken: 'new' }),
      verifyTokenScopes: async () => ({ valid: true, scopes: [], hasAiCode: false })
    };

    let notifiedState = false;
    const switcher = new AccountSwitcher(mockStorage, mockOAuth, {
      getAccounts: () => mockStorage.getAccounts(),
      setAccounts: () => {},
      getActiveEmail: () => undefined,
      setActiveEmail: () => {},
      notifyStateChange: () => { notifiedState = true; }
    });

    const success = await switcher.switchAccount('missing.aicode@example.com', false);
    assert.strictEqual(success, false, 'Must reject switch for account without aicode scope');
    assert.ok(notifiedState, 'Must notify state change to update UI badges');
    const target = savedAccounts.find((a) => a.email === 'missing.aicode@example.com');
    assert.strictEqual(target?.needsReauth, true, 'Account must be flagged with needsReauth=true');
    assert.strictEqual(target?.status, 'auth_failed', 'Account status must be updated to auth_failed');
  });

  it('syncActiveAccountToCurrentWindow uses triggerReconnect=true to trigger clean re-handshake and suppress onboarding dialog', async () => {
    let passedTriggerReconnect: boolean | undefined = undefined;
    let passedPushOnboarding: boolean | undefined = undefined;
    let liveSwitched = false;

    const mockStorage: any = {
      isValidEmail: () => true,
      getAccounts: () => [
        createMockAccount('active.in.win1@example.com', { name: 'Win 1 Active', isActive: true })
      ],
      getAccountTokens: async () => ({
        accessToken: 'ya29.win1_active_token',
        expiresAt: Date.now() + 3600000,
        hasAiCode: true
      }),
      saveAccountTokens: async () => {},
      liveSwitchOAuthToken: async (acc: any, tokens: any, skipKeyring: boolean, triggerReconnect: boolean, pushOnboarding?: boolean) => {
        liveSwitched = true;
        passedTriggerReconnect = triggerReconnect;
        passedPushOnboarding = pushOnboarding;
        return true;
      },
      onDidAccountsChange: () => {},
      onDidExternalSwitchComplete: () => {},
      onDidExternalOAuthComplete: () => {},
      getActiveAccountEmail: () => 'active.in.win1@example.com'
    };

    const mockOAuth: any = {};
    const mockQuota: any = {
      getLiveLanguageServerEmail: () => null,
      invalidateLanguageServerConnection: () => {},
      fetchActiveAccountQuotaFromIde: async () => null
    };

    const { AccountService } = require('../src/account/accountService');
    const service = new AccountService(mockStorage, mockOAuth, mockQuota);

    const result = await service.syncActiveAccountToCurrentWindow('active.in.win1@example.com');
    assert.strictEqual(result, true, 'Hot-sync must succeed');
    assert.strictEqual(liveSwitched, true, 'liveSwitchOAuthToken must be invoked');
    assert.strictEqual(
      passedTriggerReconnect,
      true,
      'triggerReconnect must be true in secondary window to trigger clean Language Server handshake'
    );
    assert.strictEqual(
      passedPushOnboarding,
      true,
      'pushOnboarding must be true in secondary window to suppress chat onboarding dialog'
    );
  });

  it('AccountAutoSwitcher automatically excludes candidates with needsReauth=true or missing aicode scope', async () => {
    const depletedActive = createMockAccount('active.depleted@example.com', {
      name: 'Active Depleted',
      isActive: true,
      status: 'healthy',
      averageQuotaPercentage: 0,
      lastRefreshedAt: new Date().toISOString(),
      quotas: [
        {
          id: 'gemini-2.5-pro',
          displayName: 'Gemini 2.5 Pro',
          percentage: 0,
          remainingFraction: 0,
          windowType: '5h',
          windowLabel: '5h Window'
        }
      ]
    });

    const unauthorizedCandidate = createMockAccount('candidate.unauthorized@example.com', {
      name: 'Candidate Unauthorized',
      isActive: false,
      status: 'healthy',
      needsReauth: true, // Marked as needs reauth
      averageQuotaPercentage: 90,
      lastRefreshedAt: new Date().toISOString(),
      quotas: [
        {
          id: 'gemini-2.5-pro',
          displayName: 'Gemini 2.5 Pro',
          percentage: 90,
          remainingFraction: 0.9,
          windowType: '5h',
          windowLabel: '5h Window'
        }
      ]
    });

    const healthyCandidate = createMockAccount('candidate.healthy@example.com', {
      name: 'Candidate Healthy',
      isActive: false,
      status: 'healthy',
      needsReauth: false,
      averageQuotaPercentage: 85,
      lastRefreshedAt: new Date().toISOString(),
      quotas: [
        {
          id: 'gemini-2.5-pro',
          displayName: 'Gemini 2.5 Pro',
          percentage: 85,
          remainingFraction: 0.85,
          windowType: '5h',
          windowLabel: '5h Window'
        }
      ]
    });

    let switchedTo: string | null = null;
    const mockStorage: any = {
      getAutoSwitchEnabled: () => true,
      getAutoSwitchTarget: () => 'instant',
      getAutoSwitchThreshold: () => 5,
      renewRefreshLease: () => {}
    };

    const { AccountAutoSwitcher } = require('../src/account/accountAutoSwitcher');
    const autoSwitcher = new AccountAutoSwitcher(mockStorage, {
      getAccounts: () => [depletedActive, unauthorizedCandidate, healthyCandidate],
      getActiveAccount: () => depletedActive,
      switchAccount: async (email: string) => {
        switchedTo = email;
        return true;
      },
      addAccountViaOAuth: async () => null,
      getIdeActiveQuota: async () => 0
    });

    await autoSwitcher.checkAutoSwitch();
    assert.strictEqual(
      switchedTo,
      'candidate.healthy@example.com',
      'Auto-switcher must skip unauthorizedCandidate (needsReauth: true) and select candidate.healthy'
    );
  });

  it('checkMissingScopes dynamically detects missing scopes against required configuration', () => {
    const { checkMissingScopes } = require('../src/auth/oauthService');
    const required = [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/aicode',
      'https://www.googleapis.com/auth/future-scope'
    ];

    // Case 1: All present
    const grantedFull = [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/aicode',
      'https://www.googleapis.com/auth/future-scope'
    ];
    assert.deepStrictEqual(checkMissingScopes(grantedFull, required), []);

    // Case 2: Missing 'future-scope' and 'aicode'
    const grantedPartial = [
      'https://www.googleapis.com/auth/cloud-platform',
      'email'
    ];
    const missing = checkMissingScopes(grantedPartial, required);
    assert.strictEqual(missing.includes('https://www.googleapis.com/auth/aicode'), true);
    assert.strictEqual(missing.includes('https://www.googleapis.com/auth/future-scope'), true);
    assert.strictEqual(missing.includes('https://www.googleapis.com/auth/cloud-platform'), false);

    // Case 3: Empty granted list
    assert.strictEqual(checkMissingScopes([], required).length, required.length);
  });
});
