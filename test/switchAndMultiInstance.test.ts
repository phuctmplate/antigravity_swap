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
  ProgressLocation: {
    Notification: 15
  },
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
    withProgress: async (_opts: any, task: any) =>
      task({ report: () => {} }, { onCancellationRequested: () => {} }),
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

  it('AccountSwitcher prevents switching to accounts whose tokens lack required IDE scopes and marks needsReauth', async () => {
    const { AccountSwitcher } = require('../src/account/accountSwitcher');

    let savedAccounts: AccountInfo[] = [];
    const mockStorage: any = {
      getAccounts: () => [
        createMockAccount('missing.scopes@example.com', { name: 'Legacy User', isActive: false })
      ],
      getAccountTokens: async () => ({
        accessToken: 'ya29.legacy_token_missing_scopes',
        refreshToken: '1//legacy_refresh',
        expiresAt: Date.now() + 3600000,
        hasRequiredScopes: false
      }),
      saveAccounts: async (accs: AccountInfo[]) => { savedAccounts = accs; },
      saveAccountTokens: async () => {},
      renewRefreshLease: () => {},
      syncGoogleAccountsJson: async () => {},
      liveSwitchOAuthToken: async () => true,
      syncToIdeStateDb: async () => {},
      syncToCloudAccountsDb: async () => {},
      broadcastSwitchCompleted: () => {},
      setActiveAccountEmail: async () => {},
      setAutoSwitchEnabled: async () => {}
    };

    const mockOAuth: any = {
      refreshAccessToken: async () => ({ accessToken: 'new' }),
      verifyTokenScopes: async () => ({ valid: true, scopes: [], hasRequiredScopes: false, hasAiCode: false })
    };

    let notifiedState = false;
    const switcher = new AccountSwitcher(mockStorage, mockOAuth, {
      getAccounts: () => mockStorage.getAccounts(),
      setAccounts: () => {},
      getActiveEmail: () => undefined,
      setActiveEmail: () => {},
      notifyStateChange: () => { notifiedState = true; }
    });

    const success = await switcher.switchAccount('missing.scopes@example.com', false);
    assert.strictEqual(success, false, 'Must reject switch for account lacking required IDE scopes');
    assert.ok(notifiedState, 'Must notify state change to update UI badges');
    const target = savedAccounts.find((a) => a.email === 'missing.scopes@example.com');
    assert.strictEqual(target?.needsReauth, true, 'Account must be flagged with needsReauth=true');
    assert.strictEqual(target?.status, 'auth_failed', 'Account status must be updated to auth_failed');
  });

  it('AccountSwitcher allows switching IDE-compatible 5-scope tokens without requiring legacy aicode scope', async () => {
    const { AccountSwitcher } = require('../src/account/accountSwitcher');
    const { OAUTH_CONFIG } = require('../src/constants');

    let activeEmailSet: string | undefined = undefined;
    let savedTokens: any = null;
    const mockStorage: any = {
      getAccounts: () => [
        createMockAccount('ide.user@example.com', { name: 'IDE User', isActive: false })
      ],
      getAccountTokens: async () => ({
        accessToken: 'ya29.ide_5scope_token',
        refreshToken: '1//ide_refresh'
        // expiresAt intentionally omitted to verify missing-expiry refresh path
      }),
      saveAccounts: async () => {},
      saveAccountTokens: async (_email: string, toks: any) => { savedTokens = toks; },
      renewRefreshLease: () => {},
      syncGoogleAccountsJson: async () => {},
      liveSwitchOAuthToken: async () => true,
      syncToIdeStateDb: async () => true,
      syncToCloudAccountsDb: async () => true,
      broadcastSwitchCompleted: () => {},
      setActiveAccountEmail: async () => {},
      setAutoSwitchEnabled: async () => {}
    };

    const mockOAuth: any = {
      refreshAccessToken: async () => ({
        accessToken: 'ya29.refreshed_5scope_token',
        refreshToken: '1//ide_refresh',
        expiresAt: Date.now() + 3600000,
        scopes: [...OAUTH_CONFIG.IDE_REQUIRED_SCOPES],
        hasRequiredScopes: true,
        hasAiCode: false
      }),
      verifyTokenScopes: async () => ({
        valid: true,
        scopes: [...OAUTH_CONFIG.IDE_REQUIRED_SCOPES],
        missingScopes: [],
        hasRequiredScopes: true,
        hasAiCode: false
      })
    };

    const switcher = new AccountSwitcher(mockStorage, mockOAuth, {
      getAccounts: () => mockStorage.getAccounts(),
      setAccounts: () => {},
      getActiveEmail: () => activeEmailSet,
      setActiveEmail: (e: string | undefined) => { activeEmailSet = e; },
      notifyStateChange: () => {}
    });

    const success = await switcher.switchAccount('ide.user@example.com', true);
    assert.strictEqual(success, true, 'Must allow switching with the 5 core IDE scopes even if aicode is absent');
    assert.strictEqual(activeEmailSet, 'ide.user@example.com');
    assert.strictEqual(savedTokens?.accessToken, 'ya29.refreshed_5scope_token');
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

  it('Model A+ AccountLifecycle never auto-activates matching IDE session when unlinked, and releases control on external sign-out/switch', async () => {
    const { AccountLifecycle } = require('../src/account/accountLifecycle');

    let accounts: AccountInfo[] = [
      createMockAccount('matching.ide@example.com', { isActive: false }),
      createMockAccount('other@example.com', { isActive: false })
    ];
    let activeEmail: string | undefined = undefined;
    let ideSessionEmail: string | undefined = undefined;
    let liveIdeState: { authState: 'signedIn' | 'signedOut' | 'unknown'; email?: string } = {
      authState: 'signedIn',
      email: 'matching.ide@example.com'
    };
    let recentExternalSwitch = false;

    const mockStorage: any = {
      isValidEmail: (e: string) => Boolean(e && e.includes('@')),
      getAccounts: () => accounts,
      saveAccounts: async (accs: AccountInfo[]) => { accounts = accs; },
      getActiveAccountEmail: () => activeEmail,
      setActiveAccountEmail: async (e: string | undefined) => { activeEmail = e; },
      getLiveIdeAuthState: async () => liveIdeState,
      hasRecentSwitchEvent: () => recentExternalSwitch
    };

    const lifecycle = new AccountLifecycle(mockStorage, {} as any, {
      getAccounts: () => accounts,
      setAccounts: (accs: AccountInfo[]) => { accounts = accs; },
      getActiveEmail: () => activeEmail,
      setActiveEmail: (e: string | undefined) => { activeEmail = e; },
      getIdeSessionEmail: () => ideSessionEmail,
      setIdeSessionEmail: (e: string | undefined) => { ideSessionEmail = e; },
      switchAccount: async () => true,
      refreshAccountQuota: async () => {},
      notifyStateChange: () => {}
    });

    // 1. Unlinked state: IDE signed into matching.ide@example.com -> hint updated, active stays undefined
    await lifecycle.handleIdeSessionChange();
    assert.strictEqual(activeEmail, undefined, 'Must NOT auto-activate when user has not clicked Switch');
    assert.strictEqual(accounts.some((a) => a.isActive), false, 'No card should be marked active automatically');
    assert.strictEqual(ideSessionEmail, 'matching.ide@example.com', 'Should detect matching IDE session email for UI hint');

    // 2. Simulate user manually clicked Switch -> extension now owns active account
    activeEmail = 'matching.ide@example.com';
    accounts = accounts.map((a) => ({ ...a, isActive: a.email === 'matching.ide@example.com' }));

    // 2a. Multi-instance broadcast guard: if another IDE window just switched, ignore mismatch
    recentExternalSwitch = true;
    liveIdeState = { authState: 'signedIn', email: 'other@example.com' };
    await lifecycle.handleIdeSessionChange();
    assert.strictEqual(activeEmail, 'matching.ide@example.com', 'Must ignore session changes while another window broadcast switch is recent');
    recentExternalSwitch = false;

    // 2b. Manual IDE sign-out -> extension releases active control cleanly
    liveIdeState = { authState: 'signedOut', email: undefined };
    await lifecycle.handleIdeSessionChange();
    assert.strictEqual(activeEmail, undefined, 'Manual IDE sign-out must clear extension activeEmail');
    assert.strictEqual(accounts.every((a) => !a.isActive), true, 'All account cards must have isActive=false after IDE sign-out');
    assert.strictEqual(ideSessionEmail, undefined);

    // 2c. Re-establish active account, then user manually logs into another account in IDE UI
    activeEmail = 'matching.ide@example.com';
    accounts = accounts.map((a) => ({ ...a, isActive: a.email === 'matching.ide@example.com' }));
    liveIdeState = { authState: 'signedIn', email: 'external.user@example.com' };
    await lifecycle.handleIdeSessionChange();
    assert.strictEqual(activeEmail, undefined, 'Manual IDE switch to another email must release extension active control');
    assert.strictEqual(ideSessionEmail, 'external.user@example.com');
  });

  it('AccountService reloadFromStorage clears stale activeEmail when another IDE instance released control', async () => {
    let diskAccounts: AccountInfo[] = [
      createMockAccount('win1@example.com', { isActive: true })
    ];
    let savedActiveEmail: string | undefined = 'win1@example.com';
    let liveIdeState: { authState: 'signedIn' | 'signedOut' | 'unknown'; email?: string } = {
      authState: 'signedIn',
      email: 'win1@example.com'
    };

    const mockStorage: any = {
      isValidEmail: () => true,
      getAccounts: () => diskAccounts,
      getActiveAccountEmail: () => savedActiveEmail,
      setActiveAccountEmail: async (e: string | undefined) => { savedActiveEmail = e; },
      getLiveIdeAuthState: async () => liveIdeState,
      onDidAccountsChange: () => {},
      onDidExternalSwitchComplete: () => {},
      onDidExternalOAuthComplete: () => {}
    };

    const { AccountService } = require('../src/account/accountService');
    const service = new AccountService(mockStorage, {} as any, {
      getLiveLanguageServerEmail: async () => undefined,
      invalidateLanguageServerConnection: () => {},
      fetchActiveAccountQuotaFromIde: async () => null,
      calculateOverallSummary: () => ({ totalAccounts: 1 })
    } as any);

    assert.strictEqual(service.getActiveAccount()?.email, 'win1@example.com');

    // Simulate Instance 1 releasing active control (accounts.json now has all isActive=false),
    // even if globalState in Instance 2 still momentarily holds old savedActiveEmail.
    diskAccounts = [createMockAccount('win1@example.com', { isActive: false })];
    liveIdeState = { authState: 'signedOut', email: undefined };

    await service.reloadFromStorage();
    assert.strictEqual(service.getActiveAccount(), undefined, 'Instance 2 must release active account when accounts.json has no active flag');
    assert.strictEqual(savedActiveEmail, undefined, 'Local activeEmail cache should align to undefined');
  });

  it('AccountSwitcher catches revoked cached token via live verifyTokenScopes and refreshes or flags NOT VERIFIED', async () => {
    const { AccountSwitcher } = require('../src/account/accountSwitcher');

    let accounts: AccountInfo[] = [
      createMockAccount('revoked.cached@example.com', { name: 'Revoked User', isActive: false })
    ];
    let savedTokens: any = null;
    const mockStorage: any = {
      getAccounts: () => accounts,
      getAccountTokens: async () => ({
        accessToken: 'ya29.revoked_cached_token',
        refreshToken: '1//revoked_refresh',
        expiresAt: Date.now() + 3600000,
        hasRequiredScopes: true
      }),
      saveAccounts: async (accs: AccountInfo[]) => { accounts = accs; },
      saveAccountTokens: async (_email: string, toks: any) => { savedTokens = toks; },
      renewRefreshLease: () => {},
      syncGoogleAccountsJson: async () => {},
      liveSwitchOAuthToken: async () => true,
      syncToIdeStateDb: async () => {},
      syncToCloudAccountsDb: async () => {},
      broadcastSwitchCompleted: () => {},
      setActiveAccountEmail: async () => {},
      setAutoSwitchEnabled: async () => {}
    };

    const mockOAuth: any = {
      verifyTokenScopes: async () => ({ valid: false, scopes: [], missingScopes: [], hasRequiredScopes: false, hasAiCode: false }),
      refreshAccessToken: async () => {
        throw new Error('AUTH_EXPIRED: invalid_grant');
      }
    };

    let activeEmail: string | undefined = undefined;
    const switcher = new AccountSwitcher(mockStorage, mockOAuth, {
      getAccounts: () => accounts,
      setAccounts: (accs: AccountInfo[]) => { accounts = accs; },
      getActiveEmail: () => activeEmail,
      setActiveEmail: (e: string | undefined) => { activeEmail = e; },
      notifyStateChange: () => {}
    });

    const ok = await switcher.switchAccount('revoked.cached@example.com', true, true);
    assert.strictEqual(ok, false, 'Must reject switch when live verifyTokenScopes fails and refresh fails with invalid_grant');
    const updated = accounts.find((a) => a.email === 'revoked.cached@example.com');
    assert.strictEqual(updated?.needsReauth, true);
    assert.strictEqual(updated?.status, 'auth_failed');
    assert.strictEqual(savedTokens?.hasRequiredScopes, false);
    assert.strictEqual(activeEmail, undefined);
  });

  it('AccountSwitcher marks NOT VERIFIED and releases active state if IDE signs out after switch', async () => {
    const { AccountSwitcher } = require('../src/account/accountSwitcher');

    let accounts: AccountInfo[] = [
      createMockAccount('prev.active@example.com', { name: 'Previous', isActive: true }),
      createMockAccount('rejected.by.ide@example.com', { name: 'Rejected', isActive: false })
    ];
    let activeEmail: string | undefined = 'prev.active@example.com';
    let savedActiveEmail: string | undefined = 'prev.active@example.com';
    let savedTokens: any = null;
    let broadcastCalled = false;

    const mockStorage: any = {
      getAccounts: () => accounts,
      getAccountTokens: async () => ({
        accessToken: 'ya29.valid_looking_token',
        refreshToken: '1//refresh',
        expiresAt: Date.now() + 3600000,
        hasRequiredScopes: true
      }),
      saveAccounts: async (accs: AccountInfo[]) => { accounts = accs; },
      saveAccountTokens: async (_email: string, toks: any) => { savedTokens = toks; },
      renewRefreshLease: () => {},
      syncGoogleAccountsJson: async () => {},
      liveSwitchOAuthToken: async () => true,
      syncToIdeStateDb: async () => {},
      syncToCloudAccountsDb: async () => {},
      getLiveIdeAuthState: async () => ({ authState: 'signedOut', email: undefined }),
      broadcastSwitchCompleted: () => { broadcastCalled = true; },
      setActiveAccountEmail: async (e: string | undefined) => { savedActiveEmail = e; },
      setAutoSwitchEnabled: async () => {}
    };

    const mockOAuth: any = {
      verifyTokenScopes: async () => ({ valid: true, scopes: [], missingScopes: [], hasRequiredScopes: true, hasAiCode: true })
    };

    let ideSessionEmail: string | undefined = 'prev.active@example.com';
    const switcher = new AccountSwitcher(mockStorage, mockOAuth, {
      getAccounts: () => accounts,
      setAccounts: (accs: AccountInfo[]) => { accounts = accs; },
      getActiveEmail: () => activeEmail,
      setActiveEmail: (e: string | undefined) => { activeEmail = e; },
      setIdeSessionEmail: (e: string | undefined) => { ideSessionEmail = e; },
      notifyStateChange: () => {}
    });

    const ok = await switcher.switchAccount('rejected.by.ide@example.com', true, true);
    assert.strictEqual(ok, false, 'Must fail switch when IDE enters signedOut state');
    assert.strictEqual(broadcastCalled, false, 'Must NOT broadcast switch completion when IDE rejected the session');
    assert.strictEqual(activeEmail, undefined, 'Must release activeEmail on rejection');
    assert.strictEqual(ideSessionEmail, undefined, 'Must clear stale IN IDE session email hint when IDE signs out');
    assert.strictEqual(savedActiveEmail, undefined, 'Must clear persisted activeEmail on rejection');
    assert.strictEqual(accounts.some((a) => a.isActive), false, 'All cards must have isActive=false');
    const rejectedAcc = accounts.find((a) => a.email === 'rejected.by.ide@example.com');
    assert.strictEqual(rejectedAcc?.needsReauth, true);
    assert.strictEqual(rejectedAcc?.status, 'auth_failed');
    assert.strictEqual(savedTokens?.hasRequiredScopes, false);
  });

  it('AccountLifecycle.reloginAccount verifies standby account without hijacking IDE, and force-syncs when already active', async () => {
    const { AccountLifecycle } = require('../src/account/accountLifecycle');

    let accounts: AccountInfo[] = [
      createMockAccount('standby.recover@example.com', {
        isActive: false,
        status: 'auth_failed',
        needsReauth: true,
        statusMessage: 'Session not verified. Click Re-login to verify.'
      }),
      createMockAccount('active.current@example.com', {
        isActive: true,
        status: 'auth_failed',
        needsReauth: true
      })
    ];
    let switchedCalls: Array<{ email: string; force?: boolean }> = [];
    let currentActive: string | undefined = 'active.current@example.com';

    const mockStorage: any = {
      saveAccountTokens: async () => {},
      saveAccounts: async (accs: AccountInfo[]) => { accounts = accs; },
      broadcastOAuthCompleted: () => {}
    };
    const mockOAuth: any = {
      loginWithGoogle: async (email: string) => ({
        tokens: {
          accessToken: `ya29.fresh_${email}`,
          refreshToken: '1//fresh_refresh',
          expiresAt: Date.now() + 3600000,
          hasRequiredScopes: true
        },
        userInfo: {
          email,
          name: 'Recovered User',
          avatarUrl: ''
        }
      }),
      cancelCurrentLogin: () => {}
    };

    const lifecycle = new AccountLifecycle(mockStorage, mockOAuth, {
      getAccounts: () => accounts,
      setAccounts: (accs: AccountInfo[]) => { accounts = accs; },
      getActiveEmail: () => currentActive,
      setActiveEmail: (e: string | undefined) => { currentActive = e; },
      switchAccount: async (email: string, _isManual?: boolean, _isSilent?: boolean, force?: boolean) => {
        switchedCalls.push({ email, force });
        return true;
      },
      refreshAccountQuota: async () => {},
      notifyStateChange: () => {}
    });

    // 1. Standby account re-login must NOT hijack active account
    const okStandby = await lifecycle.reloginAccount('standby.recover@example.com', true);
    assert.strictEqual(okStandby, true);
    assert.strictEqual(switchedCalls.length, 0, 'Standby relogin must NOT auto-switch while another account is active');
    assert.strictEqual(accounts[0].status, 'healthy');
    assert.strictEqual(accounts[0].needsReauth, false);

    // 2. Active account re-login MUST force-sync refreshed token to IDE
    const lifecycleForActive = new AccountLifecycle(mockStorage, mockOAuth, {
      getAccounts: () => accounts,
      setAccounts: (accs: AccountInfo[]) => { accounts = accs; },
      getActiveEmail: () => currentActive,
      setActiveEmail: (e: string | undefined) => { currentActive = e; },
      switchAccount: async (email: string, _isManual?: boolean, _isSilent?: boolean, force?: boolean) => {
        switchedCalls.push({ email, force });
        return true;
      },
      refreshAccountQuota: async () => {},
      notifyStateChange: () => {}
    });
    const okActive = await lifecycleForActive.reloginAccount('active.current@example.com', true);
    assert.strictEqual(okActive, true);
    assert.deepStrictEqual(switchedCalls, [{ email: 'active.current@example.com', force: true }]);
  });

  it('AccountSwitcher preserves existing active account when target fails pre-flight verification', async () => {
    const { AccountSwitcher } = require('../src/account/accountSwitcher');

    let accounts: AccountInfo[] = [
      createMockAccount('active.healthy@example.com', { isActive: true, status: 'healthy' }),
      createMockAccount('bad.target@example.com', { isActive: false, status: 'healthy' })
    ];
    let activeEmail: string | undefined = 'active.healthy@example.com';

    const mockStorage: any = {
      getAccounts: () => accounts,
      getAccountTokens: async (email: string) =>
        email === 'bad.target@example.com'
          ? { accessToken: 'ya29.revoked', refreshToken: '1//bad', expiresAt: Date.now() + 3600000 }
          : { accessToken: 'ya29.ok', expiresAt: Date.now() + 3600000 },
      saveAccounts: async (accs: AccountInfo[]) => { accounts = accs; },
      saveAccountTokens: async () => {},
      renewRefreshLease: () => {},
      setActiveAccountEmail: async (e: string | undefined) => { activeEmail = e; }
    };

    const mockOAuth: any = {
      verifyTokenScopes: async () => ({ valid: false, scopes: [], missingScopes: [], hasRequiredScopes: false, hasAiCode: false }),
      refreshAccessToken: async () => { throw new Error('invalid_grant'); }
    };

    const switcher = new AccountSwitcher(mockStorage, mockOAuth, {
      getAccounts: () => accounts,
      setAccounts: (accs: AccountInfo[]) => { accounts = accs; },
      getActiveEmail: () => activeEmail,
      setActiveEmail: (e: string | undefined) => { activeEmail = e; },
      notifyStateChange: () => {}
    });

    const ok = await switcher.switchAccount('bad.target@example.com', false, true);
    assert.strictEqual(ok, false);
    assert.strictEqual(activeEmail, 'active.healthy@example.com', 'Pre-flight target failure must NOT clear existing active account');
    assert.strictEqual(accounts.find((a) => a.email === 'active.healthy@example.com')?.isActive, true);
    const badAcc = accounts.find((a) => a.email === 'bad.target@example.com');
    assert.strictEqual(badAcc?.status, 'auth_failed');
    assert.strictEqual(badAcc?.needsReauth, true);
  });

  it('AccountService relogin recovery handles C1 fail -> C2 active vs 2-candidate failure stop vs manual switch intent', async () => {
    const { AccountService } = require('../src/account/accountService');

    let diskAccounts: AccountInfo[] = [
      createMockAccount('active.depleted@example.com', {
        isActive: true,
        tierBadge: 'PRO',
        fiveHourQuotaPercentage: 2,
        weeklyQuotaPercentage: 50,
        quotas: [{ id: 'q1', displayName: 'Gemini 3 Flash', percentage: 2, remainingFraction: 0.02, windowType: '5h', windowLabel: '5h', disabled: false }],
        lastRefreshedAt: new Date().toISOString()
      }),
      createMockAccount('cand1.notverified@example.com', {
        isActive: false,
        tierBadge: 'PRO',
        fiveHourQuotaPercentage: 90,
        weeklyQuotaPercentage: 90,
        quotas: [{ id: 'q2', displayName: 'Gemini 3 Flash', percentage: 90, remainingFraction: 0.9, windowType: '5h', windowLabel: '5h', disabled: false }],
        lastRefreshedAt: new Date().toISOString()
      }),
      createMockAccount('cand2.standby@example.com', {
        isActive: false,
        tierBadge: 'PRO',
        fiveHourQuotaPercentage: 75,
        weeklyQuotaPercentage: 80,
        quotas: [{ id: 'q3', displayName: 'Gemini 3 Flash', percentage: 75, remainingFraction: 0.75, windowType: '5h', windowLabel: '5h', disabled: false }],
        lastRefreshedAt: new Date().toISOString()
      })
    ];
    let tokensByEmail: Record<string, any> = {
      'active.depleted@example.com': { accessToken: 'ya29.active', expiresAt: Date.now() + 3600000, hasRequiredScopes: true },
      'cand1.notverified@example.com': { accessToken: 'ya29.revoked', expiresAt: Date.now() + 3600000, hasRequiredScopes: true },
      'cand2.standby@example.com': { accessToken: 'ya29.cand2', expiresAt: Date.now() + 3600000, hasRequiredScopes: true }
    };
    let autoSwitchEnabled = true;

    const mockStorage: any = {
      isValidEmail: (e: string) => Boolean(e && e.includes('@')),
      getAccounts: () => diskAccounts,
      saveAccounts: async (accs: AccountInfo[]) => { diskAccounts = accs; },
      getActiveAccountEmail: () => diskAccounts.find((a) => a.isActive)?.email,
      setActiveAccountEmail: async () => {},
      getAutoSwitchEnabled: () => autoSwitchEnabled,
      setAutoSwitchEnabled: async (v: boolean) => { autoSwitchEnabled = v; },
      getAutoSwitchTarget: () => 'instant',
      getAutoSwitchThreshold: () => 5,
      getAccountTokens: async (email: string) => tokensByEmail[email],
      saveAccountTokens: async (email: string, toks: any) => { tokensByEmail[email] = toks; },
      renewRefreshLease: () => {},
      syncToIdeStateDb: async () => {},
      syncToCloudAccountsDb: async () => {},
      syncGoogleAccountsJson: async () => {},
      liveSwitchOAuthToken: async () => true,
      broadcastSwitchCompleted: () => {},
      broadcastOAuthCompleted: () => {},
      onDidAccountsChange: () => {},
      onDidExternalSwitchComplete: () => {},
      onDidExternalOAuthComplete: () => {}
    };

    const mockOAuth: any = {
      verifyTokenScopes: async (tok: string) =>
        tok === 'ya29.revoked'
          ? { valid: false, scopes: [], missingScopes: [], hasRequiredScopes: false, hasAiCode: false }
          : { valid: true, scopes: [], missingScopes: [], hasRequiredScopes: true, hasAiCode: true },
      loginWithGoogle: async (email: string) => ({
        tokens: { accessToken: `ya29.fresh_${email}`, refreshToken: '1//fresh', expiresAt: Date.now() + 3600000, hasRequiredScopes: true },
        userInfo: { email, name: email.split('@')[0], avatarUrl: '' }
      }),
      cancelCurrentLogin: () => {}
    };

    const mockQuota: any = {
      getLiveLanguageServerEmail: async () => undefined,
      invalidateLanguageServerConnection: () => {},
      fetchActiveAccountQuotaFromIde: async () => null,
      probeJitCandidate: async (acc: AccountInfo) => ({
        ok: true,
        isDepleted: false,
        fiveHourPercentage: acc.fiveHourQuotaPercentage ?? 90,
        weeklyPercentage: acc.weeklyQuotaPercentage ?? 90
      }),
      refreshAccountQuota: async (acc: AccountInfo) => ({
        quotas: acc.quotas,
        averagePercentage: acc.averageQuotaPercentage ?? 90,
        fiveHourPercentage: acc.fiveHourQuotaPercentage ?? 90,
        weeklyPercentage: acc.weeklyQuotaPercentage ?? 90,
        hasWeeklyQuota: true,
        has5HourQuota: true,
        accountType: 'Google AI Pro',
        tierBadge: 'PRO',
        status: 'healthy' as const,
        isBanned: false
      }),
      calculateOverallSummary: () => ({ totalAccounts: diskAccounts.length })
    };

    const service = new AccountService(mockStorage, mockOAuth, mockQuota);

    // Step 1: Auto-switch tries cand1 (revoked -> NOT VERIFIED pre-flight), must immediately fall back to cand2 (succeeds!)
    await service.checkAutoSwitch();
    assert.strictEqual(service.getActiveAccount()?.email, 'cand2.standby@example.com', 'Auto-switch must land on cand2 when cand1 fails');
    assert.strictEqual(service.getAccounts().find((a: AccountInfo) => a.email === 'cand1.notverified@example.com')?.status, 'auth_failed');

    // Step 2: User clicks Re-login on cand1 while cand2 is healthy active -> MUST NOT yank active away from cand2!
    const relogOk = await service.reloginAccount('cand1.notverified@example.com', true);
    assert.strictEqual(relogOk, true);
    assert.strictEqual(service.getActiveAccount()?.email, 'cand2.standby@example.com', 'Relogging C1 while C2 is healthy active must keep C2 active');
    assert.strictEqual(service.getAccounts().find((a: AccountInfo) => a.email === 'cand1.notverified@example.com')?.status, 'healthy');

    // Step 3: Turn Auto-Switch OFF, make cand1 NOT VERIFIED, click Manual Switch on cand1 -> fails -> Re-login cand1 -> completes pending manual switch!
    autoSwitchEnabled = false;
    tokensByEmail['cand1.notverified@example.com'] = { accessToken: 'ya29.revoked', expiresAt: Date.now() + 3600000 };
    await new Promise((r) => setTimeout(r, 2050)); // Wait past SWITCH_COOLDOWN_MS from Step 1 switch to cand2
    const manualTry = await service.switchAccount('cand1.notverified@example.com', true, true);
    assert.strictEqual(manualTry, false);
    assert.strictEqual(service.getActiveAccount()?.email, 'cand2.standby@example.com');

    const recoverManual = await service.reloginAccount('cand1.notverified@example.com', true);
    assert.strictEqual(recoverManual, true);
    assert.strictEqual(service.getActiveAccount()?.email, 'cand1.notverified@example.com', 'Relogging the account just rejected during an explicit manual Switch must complete the switch');
  });

  it('AccountDiscoveryService.getLiveIdeAuthState trusts live agy server over stale USS/SQLite and supports skipDiskFallback', async () => {
    const { AccountDiscoveryService } = require('../src/storage/accountDiscovery');
    const mockDbService: any = { getSqliteDb: () => null };

    // 1. Live agy server says signedOut (hasValidAuth: false) -> MUST return signedOut even when USS/disk might hold old data
    let serverResponse: any = { reachable: true, authState: 'signedOut', email: undefined, hasValidAuth: false };
    const discovery = new AccountDiscoveryService(mockDbService, async () => serverResponse);

    const signedOutState = await discovery.getLiveIdeAuthState({ skipDiskFallback: true, forceServerRefresh: true });
    assert.strictEqual(signedOutState.authState, 'signedOut', 'Must report signedOut when agy server hasValidAuth is false');
    assert.strictEqual(signedOutState.email, undefined);

    // 2. Live agy server reports actual signed-in email -> MUST return that email
    serverResponse = { reachable: true, authState: 'signedIn', email: 'real.live.ide@gmail.com', hasValidAuth: true };
    const signedInState = await discovery.getLiveIdeAuthState({ skipDiskFallback: true, forceServerRefresh: true });
    assert.strictEqual(signedInState.authState, 'signedIn');
    assert.strictEqual(signedInState.email, 'real.live.ide@gmail.com');

    // 3. When agy server is unreachable and skipDiskFallback=true -> returns unknown (never reads self-written state.vscdb)
    serverResponse = { reachable: false, authState: 'unknown' };
    const unknownState = await discovery.getLiveIdeAuthState({ skipDiskFallback: true });
    assert.strictEqual(unknownState.authState, 'unknown');
    assert.strictEqual(unknownState.email, undefined);
  });

  it('AccountSwitcher keeps switchingEmail active during intermediate verify polls and rejects delayed signedOut', async () => {
    const { AccountSwitcher } = require('../src/account/accountSwitcher');

    let accounts: AccountInfo[] = [
      createMockAccount('old.active@example.com', { name: 'Old Active', isActive: true }),
      createMockAccount('delayed.reject@example.com', { name: 'Delayed Reject', isActive: false })
    ];
    let activeEmail: string | undefined = 'old.active@example.com';
    let pollCount = 0;
    const observedSwitchingStates: Array<string | undefined> = [];

    const mockStorage: any = {
      isValidEmail: () => true,
      getAccounts: () => accounts,
      getAccountTokens: async () => ({
        accessToken: 'ya29.delayed_reject_token',
        refreshToken: '1//refresh',
        expiresAt: Date.now() + 3600000,
        hasRequiredScopes: true
      }),
      saveAccounts: async (accs: AccountInfo[]) => { accounts = accs; },
      saveAccountTokens: async () => {},
      renewRefreshLease: () => {},
      syncGoogleAccountsJson: async () => {},
      liveSwitchOAuthToken: async () => true,
      syncToIdeStateDb: async () => true,
      syncToCloudAccountsDb: async () => true,
      getLiveIdeAuthState: async () => {
        pollCount++;
        // First 2 polls return 'unknown' while agy reconnects; poll 3+ confirms IDE rejected with signedOut
        if (pollCount <= 2) {
          observedSwitchingStates.push(switcher.getSwitchingEmail());
          return { authState: 'unknown', email: undefined };
        }
        observedSwitchingStates.push(switcher.getSwitchingEmail());
        return { authState: 'signedOut', email: undefined, rejectionMessage: 'Account requires browser sign-in.' };
      },
      broadcastSwitchCompleted: () => {},
      setActiveAccountEmail: async () => {},
      setAutoSwitchEnabled: async () => {}
    };

    const mockOAuth: any = {
      verifyTokenScopes: async () => ({ valid: true, scopes: [], missingScopes: [], hasRequiredScopes: true, hasAiCode: true })
    };

    const switcher = new AccountSwitcher(mockStorage, mockOAuth, {
      getAccounts: () => accounts,
      setAccounts: (accs: AccountInfo[]) => { accounts = accs; },
      getActiveEmail: () => activeEmail,
      setActiveEmail: (e: string | undefined) => { activeEmail = e; },
      notifyStateChange: () => {
        observedSwitchingStates.push(switcher.getSwitchingEmail());
      }
    });

    const ok = await switcher.switchAccount('delayed.reject@example.com', true, true);
    assert.strictEqual(ok, false, 'Must NOT treat initial unknown poll as accepted when later poll confirms signedOut');
    assert.strictEqual(switcher.getSwitchingEmail(), undefined, 'Must clear switchingEmail after switch finishes');
    assert.ok(pollCount >= 3, 'Must continue polling beyond unknown poll 0');
    assert.ok(
      observedSwitchingStates.slice(0, -1).every((s) => s === 'delayed.reject@example.com'),
      'Intermediate notify/poll ticks must preserve switchingEmail until checks complete'
    );
    assert.strictEqual(observedSwitchingStates[observedSwitchingStates.length - 1], undefined);
    const target = accounts.find((a) => a.email === 'delayed.reject@example.com');
    assert.strictEqual(target?.status, 'auth_failed');
    assert.strictEqual(target?.statusMessage, 'Account requires browser sign-in.');
  });

  it('AccountLifecycle fastPoll skips disk reads when steady and detects IDE sign-out via non-forced probe', async () => {
    const { AccountLifecycle } = require('../src/account/accountLifecycle');
    const { HeartbeatService } = require('../src/heartbeat/heartbeatService');

    let accounts: AccountInfo[] = [
      createMockAccount('steady.user@example.com', { name: 'Steady User', isActive: true })
    ];
    let activeEmail: string | undefined = 'steady.user@example.com';
    let ideSessionEmail: string | undefined = 'steady.user@example.com';
    let getAccountsCalls = 0;
    let notifyCount = 0;
    const probeOptions: any[] = [];
    let liveState: { authState: 'signedIn' | 'signedOut' | 'unknown'; email?: string } = {
      authState: 'signedIn',
      email: 'steady.user@example.com'
    };

    const mockStorage: any = {
      isValidEmail: (e: string) => Boolean(e && e.includes('@')),
      getAccounts: () => {
        getAccountsCalls++;
        return accounts;
      },
      saveAccounts: async (accs: AccountInfo[]) => { accounts = accs; },
      setActiveAccountEmail: async (e: string | undefined) => { activeEmail = e; },
      hasRecentSwitchEvent: () => false,
      getLiveIdeAuthState: async (opts?: any) => {
        probeOptions.push(opts);
        return liveState;
      }
    };

    const lifecycle = new AccountLifecycle(mockStorage, {} as any, {
      getAccounts: () => accounts,
      setAccounts: (accs: AccountInfo[]) => { accounts = accs; },
      getActiveEmail: () => activeEmail,
      setActiveEmail: (e: string | undefined) => { activeEmail = e; },
      getIdeSessionEmail: () => ideSessionEmail,
      setIdeSessionEmail: (e: string | undefined) => { ideSessionEmail = e; },
      switchAccount: async () => true,
      refreshAccountQuota: async () => {},
      notifyStateChange: () => { notifyCount++; }
    });

    // 1. Steady-state fastPoll -> zero disk reads, zero UI notifications, forceServerRefresh: false
    await lifecycle.handleIdeSessionChange({ fastPoll: true });
    assert.strictEqual(getAccountsCalls, 0, 'Steady-state fastPoll must skip accounts.json disk reads');
    assert.strictEqual(notifyCount, 0, 'Steady-state fastPoll must not trigger redundant state notifications');
    assert.deepStrictEqual(probeOptions[0], { skipDiskFallback: true, forceServerRefresh: false });

    // 2. IDE signs out -> fastPoll immediately releases active account & updates IN IDE hint
    liveState = { authState: 'signedOut', email: undefined };
    await lifecycle.handleIdeSessionChange({ fastPoll: true });
    assert.strictEqual(activeEmail, undefined, 'Fast poll must release activeEmail upon IDE sign-out');
    assert.strictEqual(ideSessionEmail, undefined, 'Fast poll must clear ideSessionEmail upon IDE sign-out');
    assert.strictEqual(accounts.every((a) => !a.isActive), true);
    assert.strictEqual(notifyCount, 1);

    // 3. HeartbeatService runs fast IDE session poll independently of 30s quota heartbeat
    let fastPolls = 0;
    const mockAccountService: any = {
      runHeartbeatTick: async () => {},
      pollIdeSessionFast: async () => { fastPolls++; },
      getActiveAccount: () => undefined
    };
    const hb = new HeartbeatService(mockAccountService);
    hb.start(30, 40);
    await new Promise((r) => setTimeout(r, 150));
    hb.stop();
    assert.ok(fastPolls >= 2, `Expected fast IDE session polls >= 2 within 150ms, got ${fastPolls}`);
  });

  it('Multi-instance switch lock pauses secondary window fastPoll during transitional switch verification', async () => {
    const { DistributedSyncManager } = require('../src/storage/distributedSync');
    const { AccountLifecycle } = require('../src/account/accountLifecycle');

    const mockSecrets: any = { onDidChange: () => ({ dispose: () => {} }) };
    const tmpDir = path.join(os.homedir(), '.antigravity-swap');
    const accountsFile = path.join(tmpDir, 'accounts.json');
    const manager = new DistributedSyncManager(
      mockSecrets,
      () => {},
      () => {},
      () => {},
      () => 0,
      () => accountsFile
    );

    manager.broadcastSwitchStarted('target.acc@example.com');
    assert.strictEqual(manager.hasSwitchInProgress(), true, 'Cross-window switch lock must be active');

    let accounts: AccountInfo[] = [
      createMockAccount('old.active@example.com', { isActive: true }),
      createMockAccount('target.acc@example.com', { isActive: false })
    ];
    let activeEmail: string | undefined = 'old.active@example.com';

    const mockStorage: any = {
      isValidEmail: (e: string) => Boolean(e && e.includes('@')),
      getAccounts: () => accounts,
      saveAccounts: async (accs: AccountInfo[]) => { accounts = accs; },
      setActiveAccountEmail: async (e: string | undefined) => { activeEmail = e; },
      hasSwitchInProgress: () => manager.hasSwitchInProgress(),
      hasRecentSwitchEvent: () => false,
      getLiveIdeAuthState: async () => ({ authState: 'signedOut', email: undefined })
    };

    const lifecycle = new AccountLifecycle(mockStorage, {} as any, {
      getAccounts: () => accounts,
      setAccounts: (accs: AccountInfo[]) => { accounts = accs; },
      getActiveEmail: () => activeEmail,
      setActiveEmail: (e: string | undefined) => { activeEmail = e; },
      switchAccount: async () => true,
      refreshAccountQuota: async () => {},
      notifyStateChange: () => {}
    });

    // Window 2's 2.5s poll fires while Window 1 holds the switch lock and IDE momentarily shows signedOut
    await lifecycle.handleIdeSessionChange({ fastPoll: true });
    assert.strictEqual(
      activeEmail,
      'old.active@example.com',
      'Secondary window fastPoll MUST NOT release activeEmail while another window holds .switch-lock.json'
    );
    assert.strictEqual(accounts[0].isActive, true);

    manager.clearSwitchInProgress();
    assert.strictEqual(manager.hasSwitchInProgress(), false, 'Switch lock must clear cleanly');
  });

  it('AccountLifecycle treats manual IDE sign-out after reload or recent switch without rejection error as clean logout (NOT auth_failed)', async () => {
    const { AccountLifecycle } = require('../src/account/accountLifecycle');

    let accounts: AccountInfo[] = [
      createMockAccount('logout.test@example.com', { name: 'Logout Test', isActive: true, status: 'healthy' })
    ];
    let activeEmail: string | undefined = 'logout.test@example.com';

    const mockStorage: any = {
      isValidEmail: (e: string) => Boolean(e && e.includes('@')),
      getAccounts: () => accounts,
      saveAccounts: async (accs: AccountInfo[]) => { accounts = accs; },
      setActiveAccountEmail: async (e: string | undefined) => { activeEmail = e; },
      hasSwitchInProgress: () => false,
      hasRecentSwitchEvent: () => false,
      getLiveIdeAuthState: async () => ({ authState: 'signedOut', email: undefined })
    };

    const lifecycle = new AccountLifecycle(mockStorage, {} as any, {
      getAccounts: () => accounts,
      setAccounts: (accs: AccountInfo[]) => { accounts = accs; },
      getActiveEmail: () => activeEmail,
      setActiveEmail: (e: string | undefined) => { activeEmail = e; },
      switchAccount: async () => true,
      refreshAccountQuota: async () => {},
      notifyStateChange: () => {}
    });

    // Simulate startup cooldown + recent manual switch, followed by manual IDE sign-out >2.5s later
    lifecycle.recordSessionSyncCooldown();
    lifecycle.recordManualSwitch('logout.test@example.com');
    (lifecycle as any).lastManualSwitchTime = Date.now() - 4000;

    await lifecycle.handleIdeSessionChange({ fastPoll: true });
    assert.strictEqual(activeEmail, undefined, 'Manual IDE sign-out must release activeEmail');
    assert.strictEqual(accounts[0].isActive, false);
    assert.strictEqual(accounts[0].status, 'healthy', 'Manual IDE sign-out without rejection error MUST keep account healthy (not auth_failed)');
    assert.notStrictEqual(accounts[0].needsReauth, true);
  });

  it('AccountService keeps forceRefresh=false for StatusBar IDE quota reads while AutoSwitcher uses forceRefresh=true', async () => {
    const { AccountService } = require('../src/account/accountService');

    const capturedCalls: Array<{ forceRefresh: boolean; bypassSharedCache?: boolean; cacheTtlMs?: number }> = [];
    const activeAcc = createMockAccount('quota.mode@example.com', { isActive: true });

    const mockStorage: any = {
      isValidEmail: (e: string) => Boolean(e && e.includes('@')),
      getAccounts: () => [activeAcc],
      saveAccounts: async () => {},
      getActiveAccountEmail: () => 'quota.mode@example.com',
      setActiveAccountEmail: async () => {},
      getAutoSwitchEnabled: () => false,
      getAutoSwitchTarget: () => 'gemini',
      getAutoSwitchThreshold: () => 5,
      onDidAccountsChange: () => {},
      onDidExternalSwitchComplete: () => {},
      onDidExternalOAuthComplete: () => {}
    };

    const mockQuota: any = {
      getLiveLanguageServerEmail: async () => undefined,
      invalidateLanguageServerConnection: () => {},
      fetchActiveAccountQuotaFromIde: async (_timeoutMs: number, forceRefresh: boolean, opts?: any) => {
        capturedCalls.push({
          forceRefresh,
          bypassSharedCache: opts?.bypassSharedCache,
          cacheTtlMs: opts?.cacheTtlMs
        });
        return null;
      },
      calculateOverallSummary: () => ({ totalAccounts: 1 })
    };

    const service = new AccountService(mockStorage, {} as any, mockQuota);

    // 1. StatusBar path defaults to forceRefresh=false (reads agy.exe in-memory cache without forcing Google API)
    await service.getActiveAccountIdeQuota(2500, { expectedEmail: activeAcc.email, cacheTtlMs: 25000 });
    assert.strictEqual(capturedCalls[0]?.forceRefresh, false);

    // 2. AutoSwitcher secondary guard reuses recent shared cache (5s TTL) right after heartbeat, forcing only if stale
    await (service as any).autoSwitcher.ctx.getIdeActiveQuota();
    assert.strictEqual(capturedCalls[1]?.forceRefresh, true);
    assert.strictEqual(capturedCalls[1]?.bypassSharedCache, false);
    assert.strictEqual(capturedCalls[1]?.cacheTtlMs, 5000);
  });

  it('QuotaService uses shared agy.exe forceRefresh=true once for active account and skips Google direct API when IDE responds', async () => {
    const { QuotaService } = require('../src/quota/quotaService');

    const quotaService = new QuotaService({} as any);
    let ideCalls = 0;
    let directApiCalls = 0;

    quotaService.fetchActiveAccountQuotaFromIde = async (_timeoutMs: number, forceRefresh: boolean) => {
      ideCalls++;
      assert.strictEqual(forceRefresh, true);
      return {
        email: 'shared.active@example.com',
        name: 'Shared Active',
        planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' },
        fetchedAt: Date.now(),
        geminiInstantPercentage: 80,
        claudeInstantPercentage: 60,
        accountInstantPercentage: 77,
        overallQuotaPercentage: 88,
        rawGroups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', remainingFraction: 0.8 },
              { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 0.9 }
            ]
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { bucketId: 'claude-5h', displayName: 'Five Hour Limit Remaining', remainingFraction: 0.6 },
              { bucketId: 'claude-weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 0.85 }
            ]
          }
        ]
      };
    };

    (quotaService as any).apiClient.fetchLiveQuotaData = async () => {
      directApiCalls++;
      return {
        userTier: { id: 'standard-free' },
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [{ bucketId: 'gemini-weekly', remainingFraction: 0.7 }]
          }
        ]
      };
    };

    const activeAcc = createMockAccount('shared.active@example.com', { isActive: true });
    const tokens: OAuthTokens = { accessToken: 'ya29.shared', expiresAt: Date.now() + 3600000 };

    const activeRes = await quotaService.fetchAccountQuotas(activeAcc, tokens);
    assert.strictEqual(ideCalls, 1, 'Active account must query shared agy.exe IDE source once');
    assert.strictEqual(directApiCalls, 0, 'Active account must NOT fire duplicate direct Google API call when IDE source succeeds');
    assert.strictEqual(activeRes.geminiGroup?.fiveHour?.percentage, 80);
    assert.strictEqual(activeRes.claudeGptGroup?.fiveHour?.percentage, 60);
    assert.strictEqual(activeRes.fiveHourPercentage, 77);
    assert.strictEqual(activeRes.weeklyPercentage, 89);
    assert.strictEqual(activeRes.tierBadge, 'PRO');

    // Standby account must bypass IDE source and query Google direct API
    const standbyAcc = createMockAccount('standby.user@example.com', { isActive: false });
    await quotaService.fetchAccountQuotas(standbyAcc, tokens);
    assert.strictEqual(ideCalls, 1, 'Standby account must not call IDE agy.exe source');
    assert.strictEqual(directApiCalls, 1, 'Standby account must query Google direct API');
  });

  it('AccountQuotaSync.syncActiveAccountFromIdeSmart catches organic agy updates at 0 Google cost and only forces refresh after 20s idle', async () => {
    const { AccountQuotaSync } = require('../src/account/accountQuotaSync');
    const { QuotaService } = require('../src/quota/quotaService');

    const realParserService = new QuotaService({} as any);
    let accounts: AccountInfo[] = [
      createMockAccount('smart.active@example.com', {
        isActive: true,
        fiveHourQuotaPercentage: 85,
        weeklyQuotaPercentage: 90,
        lastRefreshedAt: new Date(Date.now() - 4000).toISOString(),
        geminiGroup: {
          id: 'gemini',
          name: 'Gemini Models',
          fiveHour: { bucketId: 'gemini-5h', displayName: '5h', window: '5h', percentage: 85, remainingFraction: 0.85 },
          weekly: { bucketId: 'gemini-weekly', displayName: 'Weekly', window: 'weekly', percentage: 90, remainingFraction: 0.9 },
          buckets: []
        }
      })
    ];

    let passiveCalls = 0;
    let forcedCalls = 0;
    let notifyCount = 0;
    let autoSwitchChecks = 0;
    let mockPassiveFraction = 0.75; // Changed from 0.85 -> 0.75 (agy updated organically!)

    const makeIdeRes = (frac: number) => ({
      email: 'smart.active@example.com',
      name: 'Smart Active',
      planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' },
      fetchedAt: Date.now(),
      geminiInstantPercentage: Math.round(frac * 100),
      claudeInstantPercentage: 100,
      accountInstantPercentage: Math.round(frac * 100),
      overallQuotaPercentage: 90,
      geminiGroup: {
        id: 'gemini',
        name: 'Gemini Models',
        fiveHour: { bucketId: 'gemini-5h', displayName: '5h', window: '5h', percentage: Math.round(frac * 100), remainingFraction: frac },
        weekly: { bucketId: 'gemini-weekly', displayName: 'Weekly', window: 'weekly', percentage: 90, remainingFraction: 0.9 },
        buckets: []
      },
      rawGroups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', remainingFraction: frac },
            { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 0.9 }
          ]
        }
      ]
    });

    const mockStorage: any = {
      getAccounts: () => accounts,
      saveAccounts: async (accs: AccountInfo[]) => { accounts = accs; },
      getAccountTokens: async () => ({ accessToken: 'ya29.smart', expiresAt: Date.now() + 3600000 }),
      getActiveAccountEmail: () => 'smart.active@example.com',
      renewRefreshLease: () => {}
    };

    const mockQuotaService: any = {
      fetchActiveAccountQuotaFromIde: async (_timeoutMs: number, forceRefresh: boolean) => {
        if (forceRefresh) forcedCalls++;
        else passiveCalls++;
        return makeIdeRes(mockPassiveFraction);
      },
      parseIdeQuotaResult: (ideRes: any, acc: AccountInfo) => realParserService.parseIdeQuotaResult(ideRes, acc),
      fetchAccountQuotas: async (_acc: AccountInfo) => {
        forcedCalls++;
        return realParserService.parseIdeQuotaResult(makeIdeRes(mockPassiveFraction), _acc);
      }
    };

    const sync = new AccountQuotaSync(mockStorage, mockQuotaService, {
      getAccounts: () => accounts,
      setAccounts: (accs: AccountInfo[]) => { accounts = accs; },
      getActiveAccount: () => accounts[0],
      reloadFromStorage: async () => {},
      checkAutoSwitch: async () => { autoSwitchChecks++; },
      checkExternalIdeSession: async () => {},
      notifyStateChange: () => { notifyCount++; }
    });

    // 1. Organic agy update (0.85 -> 0.75): updates UI + resets freshness WITHOUT forcing Google refresh
    await sync.syncActiveAccountFromIdeSmart();
    assert.strictEqual(passiveCalls, 1);
    assert.strictEqual(forcedCalls, 0, 'Must NOT forceRefresh when agy already reported updated quota organically');
    assert.strictEqual(accounts[0].fiveHourQuotaPercentage, 75);
    assert.strictEqual(notifyCount, 1);
    assert.strictEqual(autoSwitchChecks, 1);

    // 2. Unchanged & < 20s since last update (even at 16s) -> does nothing (0 forced calls, 0 redundant saves)
    accounts[0].lastRefreshedAt = new Date(Date.now() - 16000).toISOString();
    await sync.syncActiveAccountFromIdeSmart();
    assert.strictEqual(passiveCalls, 2);
    assert.strictEqual(forcedCalls, 0, 'Must skip forceRefresh when unchanged and within 20s freshness window');
    assert.strictEqual(notifyCount, 1);

    // 3. Unchanged & >= 20s elapsed -> runs single shared forceRefresh=true fallback
    accounts[0].lastRefreshedAt = new Date(Date.now() - 21000).toISOString();
    await sync.syncActiveAccountFromIdeSmart();
    assert.strictEqual(passiveCalls, 3);
    assert.strictEqual(forcedCalls, 1, 'Must trigger single forceRefresh=true after 20s without organic changes');
    assert.strictEqual(autoSwitchChecks, 2);
  });
});
