import * as vscode from 'vscode';
import { AccountInfo, OAuthTokens, OverallQuotaSummary, AutoSwitchTarget } from './types';
import { StorageService } from './storage';
import { OAuthService } from './oauthService';
import { QuotaService } from './quotaService';
import { CONFIG_KEYS, EXTENSION_DEFAULTS } from './constants';

export class AccountManager {
  private accounts: AccountInfo[] = [];
  private activeEmail?: string;
  private isSwitching = false;
  private lastSwitchTime = 0;
  private static readonly SWITCH_COOLDOWN_MS = EXTENSION_DEFAULTS.SWITCH_COOLDOWN_MS;
  private isImporting = false;
  private lastImportTime = 0;
  private static readonly IMPORT_COOLDOWN_MS = EXTENSION_DEFAULTS.IMPORT_COOLDOWN_MS;
  private lastOAuthTime = 0;
  private static readonly OAUTH_COOLDOWN_MS = EXTENSION_DEFAULTS.OAUTH_COOLDOWN_MS;
  private readonly _onDidChangeState = new vscode.EventEmitter<void>();
  public readonly onDidChangeState = this._onDidChangeState.event;

  constructor(
    private readonly storage: StorageService,
    private readonly oauthService: OAuthService,
    private readonly quotaService: QuotaService
  ) {
    // Synchronously preload accounts and activeEmail from in-memory globalState (0ms)
    const rawAccounts = this.storage.getAccounts();
    this.accounts = rawAccounts.filter((a) => this.storage.isValidEmail(a.email));
    this.activeEmail = this.storage.getActiveAccountEmail();
  }

  public async initialize(): Promise<void> {
    const rawAccounts = this.storage.getAccounts();
    this.accounts = rawAccounts.filter((a) => this.storage.isValidEmail(a.email));
    if (this.accounts.length !== rawAccounts.length) {
      await this.storage.saveAccounts(this.accounts);
      console.log(`[Antigravity Swap] Sanitized ${rawAccounts.length - this.accounts.length} invalid/phantom account(s).`);
    }

    // Read currently active IDE session
    const currentSession = await this.storage.getCurrentAntigravityAccount().catch(() => null);

    if (!currentSession || !currentSession.email || !this.storage.isValidEmail(currentSession.email)) {
      // IDE is currently logged out!
      this.activeEmail = undefined;
      this.accounts = this.accounts.map((a) => ({ ...a, isActive: false }));
      await this.storage.setActiveAccountEmail(undefined);
    } else {
      // IDE has an active session: align active account with IDE or savedActive
      const ideEmail = currentSession.email.toLowerCase();
      const savedActive = this.storage.getActiveAccountEmail()?.toLowerCase();
      const effectiveEmail = (savedActive && this.accounts.some((a) => a.email.toLowerCase() === savedActive))
        ? savedActive
        : (this.accounts.some((a) => a.email.toLowerCase() === ideEmail))
          ? ideEmail
          : undefined;

      if (effectiveEmail) {
        this.activeEmail = effectiveEmail;
        this.accounts = this.accounts.map((a) => ({
          ...a,
          isActive: a.email.toLowerCase() === effectiveEmail
        }));
        await this.storage.setActiveAccountEmail(effectiveEmail);
        await this.storage.syncGoogleAccountsJson(effectiveEmail);
      }
    }

    // Auto-discover previous accounts from system if list is empty
    if (this.accounts.length === 0) {
      await this.importDetectedAccounts();
    }

    // Listen to external accounts storage changes (e.g. from other IDE instances/windows)
    this.storage.onDidAccountsChange(async () => {
      await this.reloadFromStorage();
    });

    // Listen to external OAuth completions (e.g. from other IDE windows/instances)
    this.storage.onDidExternalOAuthComplete((event) => {
      if (this.oauthService.isLoginInProgress()) {
        const activeHint = this.oauthService.getActiveSessionLoginHint();
        if (!activeHint || activeHint.toLowerCase() === event.email.toLowerCase()) {
          console.log(`[Antigravity Swap] External OAuth completed for ${event.email}. Cancelling pending local OAuth flow.`);
          this.oauthService.cancelCurrentLogin('Login cancelled (completed in another window).');
        }
      }
    });

    // Listen to IDE window focus to sync external file/state updates & IDE session changes
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) {
        this.reloadFromStorage().catch(() => {});
        this.handleIdeSessionChange().catch(() => {});
        this.storage.checkExternalOAuthEvent();
      }
    });

    // Initial quota check only for accounts with valid tokens
    await this.refreshAllQuotas().catch((err) => console.warn('[Antigravity Swap] Initial quota refresh failed:', err));

    // ONLY auto-switch if auto-switch is explicitly enabled by user AND quotas were loaded
    if (this.isAutoSwitchEnabled()) {
      await this.checkAutoSwitch();
    }
  }

  /**
   * Reloads accounts and active email state from shared storage (triggered by external instance changes).
   */
  public async reloadFromStorage(): Promise<void> {
    const rawAccounts = this.storage.getAccounts();
    const cleanAccounts = rawAccounts.filter((a) => this.storage.isValidEmail(a.email));
    this.accounts = cleanAccounts;
    const active = this.storage.getActiveAccountEmail();
    this.activeEmail = (active && this.accounts.some((a) => a.email === active)) ? active : this.accounts.find((a) => a.isActive)?.email;
    this._onDidChangeState.fire();
  }

  /**
   * Handles VS Code workspace configuration updates across all instances.
   */
  public handleConfigurationChange(): void {
    this._onDidChangeState.fire();
    if (this.isAutoSwitchEnabled()) {
      this.checkAutoSwitch().catch(() => {});
    }
  }

  /**
   * Handles real-time IDE auth session changes (login / logout / switch).
   * - If user logs out from IDE: clears active account state so extension reflects logout.
   * - If user logs in on IDE: synchronizes active state and tokens for that account.
   */
  public async handleIdeSessionChange(): Promise<void> {
    await new Promise((r) => setTimeout(r, 150));

    const currentSession = await this.storage.getCurrentAntigravityAccount().catch(() => null);

    if (!currentSession || !currentSession.email || !this.storage.isValidEmail(currentSession.email) || !currentSession.accessToken) {
      // IDE is logged out!
      if (this.activeEmail !== undefined || this.accounts.some((a) => a.isActive)) {
        console.log('[Antigravity Swap] Detected IDE logout: clearing active account selection.');
        this.activeEmail = undefined;
        this.accounts = this.accounts.map((a) => ({ ...a, isActive: false }));
        await this.storage.setActiveAccountEmail(undefined);
        await this.storage.saveAccounts(this.accounts);
        this._onDidChangeState.fire();
      }
      return;
    }

    // IDE is logged in to a valid account!
    const email = currentSession.email.trim().toLowerCase();
    const existingAcc = this.accounts.find((a) => a.email.toLowerCase() === email);

    if (existingAcc) {
      // Update tokens
      const existingTokens = await this.storage.getAccountTokens(existingAcc.email);
      const tokens: OAuthTokens = {
        accessToken: currentSession.accessToken,
        refreshToken: currentSession.refreshToken || existingTokens?.refreshToken,
        expiresAt: Date.now() + 3600 * 1000
      };
      await this.storage.saveAccountTokens(existingAcc.email, tokens);

      // Set active
      this.activeEmail = existingAcc.email;
      this.accounts = this.accounts.map((a) => ({
        ...a,
        isActive: a.email.toLowerCase() === email,
        status: a.email.toLowerCase() === email ? 'active' : a.status,
        statusMessage: a.email.toLowerCase() === email ? undefined : a.statusMessage,
        name: (a.email.toLowerCase() === email && currentSession.name) ? currentSession.name : a.name,
        avatarUrl: (a.email.toLowerCase() === email && currentSession.avatarUrl) ? currentSession.avatarUrl : a.avatarUrl
      }));
      await this.storage.setActiveAccountEmail(existingAcc.email);
      await this.storage.saveAccounts(this.accounts);
      this._onDidChangeState.fire();
      this.refreshAccountQuota(existingAcc.email).catch(() => {});
      console.log(`[Antigravity Swap] Synchronized active account to ${existingAcc.email} following IDE login.`);
    } else {
      // Current IDE session is not in extension: clear active flag on extension accounts
      if (this.activeEmail !== undefined) {
        this.activeEmail = undefined;
        this.accounts = this.accounts.map((a) => ({ ...a, isActive: false }));
        await this.storage.setActiveAccountEmail(undefined);
        await this.storage.saveAccounts(this.accounts);
        this._onDidChangeState.fire();
      }
    }
  }

  /**
   * Checks if an external IDE login occurred for an account already in the extension.
   */
  public async checkExternalIdeSession(): Promise<void> {
    await this.handleIdeSessionChange();
  }

  /**
   * Syncs initial active account status from the IDE's internal state.vscdb if none is selected
   */
  public async syncCurrentAccountFromIde(): Promise<void> {
    await this.handleIdeSessionChange();
  }

  public getAccounts(): AccountInfo[] {
    return this.accounts;
  }

  public getActiveAccount(): AccountInfo | undefined {
    if (!this.activeEmail) return undefined;
    const match = this.accounts.find((a) => a.email === this.activeEmail && a.isActive);
    return match;
  }

  public getOverallSummary(): OverallQuotaSummary {
    return this.quotaService.calculateOverallSummary(this.accounts);
  }

  public isAutoSwitchEnabled(): boolean {
    return this.storage.getAutoSwitchEnabled();
  }

  public async setAutoSwitchEnabled(enabled: boolean): Promise<void> {
    await this.storage.setAutoSwitchEnabled(enabled);
    this._onDidChangeState.fire();
  }

  public getAutoSwitchTarget(): AutoSwitchTarget {
    return this.storage.getAutoSwitchTarget();
  }

  public async setAutoSwitchTarget(target: AutoSwitchTarget): Promise<void> {
    await this.storage.setAutoSwitchTarget(target);
    this._onDidChangeState.fire();
  }

  public getAutoSwitchThreshold(): number {
    return this.storage.getAutoSwitchThreshold();
  }

  public async setAutoSwitchThreshold(threshold: number): Promise<void> {
    await this.storage.setAutoSwitchThreshold(threshold);
    this._onDidChangeState.fire();
  }

  public getWeeklyQuotaProtectionThreshold(): number {
    return this.storage.getWeeklyQuotaProtectionThreshold();
  }

  public async setWeeklyQuotaProtectionThreshold(threshold: number): Promise<void> {
    await this.storage.setWeeklyQuotaProtectionThreshold(threshold);
    this._onDidChangeState.fire();
  }

  /**
   * Switches to the given account and relaunches Antigravity IDE with the new account loaded into memory.
   * @param email Target account email.
   * @param isManual Set to true when the user explicitly pressed "Switch" — this disables auto-switch.
   */
  public async switchAccount(email: string, isManual = false): Promise<boolean> {
    const now = Date.now();
    if (this.isSwitching || now - this.lastSwitchTime < AccountManager.SWITCH_COOLDOWN_MS) {
      console.log('[Antigravity Swap] Switch rate-limited / cooldown active. Ignored.');
      return false;
    }

    if (this.activeEmail === email) {
      return true;
    }

    this.isSwitching = true;
    this.lastSwitchTime = now;

    try {
      const target = this.accounts.find((a) => a.email === email);
      if (!target) {
        vscode.window.showErrorMessage(`Account ${email} not found in Antigravity Swap.`);
        return false;
      }

      if (target.isBanned || target.status === 'banned') {
        vscode.window.showErrorMessage(`Cannot switch: Account ${email} is banned or suspended by Google Terms of Service.`);
        return false;
      }

      if (target.status === 'auth_failed') {
        return false;
      }

      let tokens = await this.storage.getAccountTokens(email);
      if (!tokens || !tokens.accessToken) {
        target.status = 'auth_failed';
        target.statusMessage = 'Credentials missing. Re-login required.';
        target.quotas = [];
        target.averageQuotaPercentage = 0;
        await this.storage.saveAccounts(this.accounts);
        this._onDidChangeState.fire();
        return false;
      }

      // Check if access token is expired and refresh
      if (tokens.expiresAt && Date.now() > tokens.expiresAt - 60000 && tokens.refreshToken) {
        try {
          tokens = await this.oauthService.refreshAccessToken(tokens.refreshToken);
          await this.storage.saveAccountTokens(email, tokens);
        } catch (err: any) {
          console.warn(`[Antigravity Swap] Token refresh failed before switch: ${err.message}`);
          target.status = 'auth_failed';
          target.statusMessage = 'Credentials expired. Re-login required.';
          target.quotas = [];
          target.averageQuotaPercentage = 0;
          await this.storage.saveAccounts(this.accounts);
          this._onDidChangeState.fire();
          return false;
        }
      } else if (tokens.expiresAt && Date.now() > tokens.expiresAt && !tokens.refreshToken) {
        // Access token expired and no refresh token available
        target.status = 'auth_failed';
        target.statusMessage = 'Session expired. Re-login required.';
        await this.storage.saveAccounts(this.accounts);
        this._onDidChangeState.fire();
        return false;
      }

      const previousEmail = this.activeEmail || this.accounts.find((a) => a.isActive)?.email;

      // 1. Update internal state
      this.accounts = this.accounts.map((a) => ({
        ...a,
        isActive: a.email === email,
        lastUsedAt: a.email === email ? new Date().toISOString() : a.lastUsedAt
      }));
      this.activeEmail = email;
      await this.storage.saveAccounts(this.accounts);
      await this.storage.setActiveAccountEmail(email);

      // 2. If the user manually chose this account, disable auto-switch so it won't override their choice
      if (isManual) {
        await this.storage.setAutoSwitchEnabled(false);
      }

      // 3. Update google_accounts.json FIRST so the new active email and old list are in place for eviction
      await this.storage.syncGoogleAccountsJson(email);

      // 4. Hot-switch in-memory via Unified State Sync API so language server and agent immediately get the new token!
      const liveSwitchOk = await this.storage.liveSwitchOAuthToken(target, tokens);

      // 5. Explicitly evict previous sessions via antigravity.evictAuthSession if available
      if (previousEmail && previousEmail !== email) {
        try {
          await vscode.commands.executeCommand('antigravity.evictAuthSession', previousEmail);
        } catch (_) {}
      }
      for (const a of this.accounts) {
        if (a.email !== email) {
          try {
            await vscode.commands.executeCommand('antigravity.evictAuthSession', a.email);
          } catch (_) {}
        }
      }

      // 6. Update IDE state database (state.vscdb) and cloud agent DB in-place
      await this.storage.syncToIdeStateDb(target, tokens, liveSwitchOk);
      await this.storage.syncToCloudAccountsDb(email);

      // 7. Hot-restart the Antigravity Language Server in the background so it immediately picks up new credentials without closing IDE
      try {
        await vscode.commands.executeCommand('antigravity.restartLanguageServer');
        console.log('[Antigravity Swap] Executed antigravity.restartLanguageServer successfully');
      } catch (lsErr: any) {
        console.warn('[Antigravity Swap] restartLanguageServer command warning:', lsErr?.message || lsErr);
      }

      this._onDidChangeState.fire();
      this.refreshAccountQuota(email).catch(() => {});

      vscode.window.showInformationMessage(`Switched to: ${target.name || email}!`);
      return true;
    } finally {
      this.isSwitching = false;
    }
  }

  /**
   * Re-authenticates / reconnects a specific account by launching Google browser login.
   */
  public async reloginAccount(email: string): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastOAuthTime < AccountManager.OAUTH_COOLDOWN_MS) {
      return false;
    }
    this.lastOAuthTime = now;

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Antigravity Swap: Opening browser to authenticate ${email}...`,
          cancellable: true
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            this.oauthService.cancelCurrentLogin('User cancelled login.');
          });
          return await this.oauthService.loginWithGoogle(email);
        }
      );

      const { tokens, userInfo } = result;
      await this.storage.saveAccountTokens(userInfo.email, tokens);

      const existingIdx = this.accounts.findIndex((a) => a.email === userInfo.email || a.email === email);
      if (existingIdx >= 0) {
        this.accounts[existingIdx] = {
          ...this.accounts[existingIdx],
          email: userInfo.email,
          name: userInfo.name || this.accounts[existingIdx].name,
          avatarUrl: userInfo.avatarUrl || this.accounts[existingIdx].avatarUrl,
          status: 'active',
          isBanned: false,
          banReason: undefined,
          statusMessage: undefined,
          lastUsedAt: new Date().toISOString()
        };
      } else {
        this.accounts.push({
          id: Buffer.from(userInfo.email).toString('base64').substring(0, 16),
          email: userInfo.email,
          name: userInfo.name,
          avatarUrl: userInfo.avatarUrl,
          isActive: false,
          addedAt: new Date().toISOString(),
          status: 'active',
          isBanned: false,
          quotas: [],
          averageQuotaPercentage: 0,
          hasWeeklyQuota: false,
          has5HourQuota: false,
          accountType: 'Standard Free',
          tierBadge: 'STANDARD FREE'
        });
      }

      await this.storage.saveAccounts(this.accounts);
      this.storage.broadcastOAuthCompleted(userInfo.email);
      vscode.window.showInformationMessage(`Re-authenticated ${userInfo.email} successfully!`);
      this._onDidChangeState.fire();

      await this.refreshAccountQuota(userInfo.email).catch(() => {});

      if (this.activeEmail === userInfo.email || this.activeEmail === email) {
        await this.switchAccount(userInfo.email);
      }

      return true;
    } catch (err: any) {
      const msg = err.message || '';
      if (!msg.toLowerCase().includes('cancel') && !msg.toLowerCase().includes('replace')) {
        vscode.window.showErrorMessage(`Re-login error: ${err.message}`);
      }
      return false;
    }
  }

  /**
   * Imports or updates the account currently logged into Antigravity IDE.
   */
  public async importCurrentAntigravityAccount(): Promise<AccountInfo | null> {
    const now = Date.now();
    if (this.isImporting || (now - this.lastImportTime < AccountManager.IMPORT_COOLDOWN_MS)) {
      return null;
    }
    this.isImporting = true;
    this.lastImportTime = now;

    try {
      const current = await this.storage.getCurrentAntigravityAccount();
      if (!current || !current.email || !this.storage.isValidEmail(current.email) || !current.accessToken) {
        vscode.window.showWarningMessage('No active Antigravity session with valid access token found in IDE.');
        return null;
      }

      const existingTokens = await this.storage.getAccountTokens(current.email);
      const tokens: OAuthTokens = {
        accessToken: current.accessToken,
        refreshToken: current.refreshToken || existingTokens?.refreshToken,
        expiresAt: Date.now() + 3600 * 1000
      };

      await this.storage.saveAccountTokens(current.email, tokens);

      const existingIdx = this.accounts.findIndex((a) => a.email === current.email);
      let account: AccountInfo;

      if (existingIdx >= 0) {
        account = {
          ...this.accounts[existingIdx],
          name: current.name || this.accounts[existingIdx].name,
          avatarUrl: current.avatarUrl || this.accounts[existingIdx].avatarUrl,
          status: 'active',
          isBanned: false,
          statusMessage: undefined,
          isActive: true,
          lastUsedAt: new Date().toISOString()
        };
        this.accounts[existingIdx] = account;
      } else {
        account = {
          id: Buffer.from(current.email).toString('base64').substring(0, 16),
          email: current.email,
          name: current.name,
          avatarUrl: current.avatarUrl,
          isActive: true,
          addedAt: new Date().toISOString(),
          status: 'active',
          isBanned: false,
          statusMessage: undefined,
          quotas: [],
          averageQuotaPercentage: 0,
          hasWeeklyQuota: false,
          has5HourQuota: false,
          accountType: 'Standard Free',
          tierBadge: 'STANDARD FREE'
        };
        this.accounts.push(account);
      }

      // Set other accounts isActive = false
      this.accounts = this.accounts.map((a) => ({
        ...a,
        isActive: a.email === current.email
      }));
      this.activeEmail = current.email;

      await this.storage.saveAccounts(this.accounts);
      if (existingIdx >= 0) {
        vscode.window.showInformationMessage(`Account ${current.email} is already in the list.`);
      } else {
        vscode.window.showInformationMessage(`Successfully imported new account ${current.email} from Antigravity IDE!`);
      }
      this._onDidChangeState.fire();

      this.refreshAccountQuota(current.email).catch(() => {});
      return account;
    } finally {
      this.isImporting = false;
    }
  }

  /**
   * Adds an account via Google OAuth web authorization.
   */
  public async addAccountViaOAuth(): Promise<AccountInfo | null> {
    const now = Date.now();
    if (now - this.lastOAuthTime < AccountManager.OAUTH_COOLDOWN_MS) {
      return null;
    }
    this.lastOAuthTime = now;

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Antigravity Swap: Opening browser to authenticate with Google...',
          cancellable: true
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            this.oauthService.cancelCurrentLogin('User cancelled login.');
          });
          return await this.oauthService.loginWithGoogle();
        }
      );

      const { tokens, userInfo } = result;
      await this.storage.saveAccountTokens(userInfo.email, tokens);

      const existingIdx = this.accounts.findIndex((a) => a.email === userInfo.email);
      let account: AccountInfo;

      if (existingIdx >= 0) {
        account = {
          ...this.accounts[existingIdx],
          name: userInfo.name || this.accounts[existingIdx].name,
          avatarUrl: userInfo.avatarUrl || this.accounts[existingIdx].avatarUrl,
          status: 'active',
          isBanned: false,
          lastUsedAt: new Date().toISOString()
        };
        this.accounts[existingIdx] = account;
      } else {
        account = {
          id: Buffer.from(userInfo.email).toString('base64').substring(0, 16),
          email: userInfo.email,
          name: userInfo.name,
          avatarUrl: userInfo.avatarUrl,
          isActive: this.accounts.length === 0,
          addedAt: new Date().toISOString(),
          status: 'active',
          isBanned: false,
          quotas: [],
          averageQuotaPercentage: 0,
          hasWeeklyQuota: false,
          has5HourQuota: false,
          accountType: 'Standard Free',
          tierBadge: 'STANDARD FREE'
        };
        this.accounts.push(account);
      }

      await this.storage.saveAccounts(this.accounts);
      this.storage.broadcastOAuthCompleted(userInfo.email);
      if (account.isActive) {
        await this.switchAccount(account.email);
      }

      vscode.window.showInformationMessage(`Added account ${userInfo.email} to Antigravity Swap!`);
      this._onDidChangeState.fire();

      this.refreshAccountQuota(account.email, true).catch(() => {});
      return account;
    } catch (err: any) {
      const msg = err.message || '';
      if (!msg.toLowerCase().includes('cancel') && !msg.toLowerCase().includes('replace')) {
        vscode.window.showErrorMessage(`Login failed: ${err.message}`);
      }
      return null;
    }
  }

  /**
   * Adds an account manually via Access Token or Refresh Token input.
   */
  public async addAccountManually(email: string, accessToken: string, refreshToken?: string, name?: string): Promise<boolean> {
    if (!email || !accessToken) {
      vscode.window.showErrorMessage('Email and Access Token are required.');
      return false;
    }

    const tokens: OAuthTokens = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + 3600 * 1000
    };

    await this.storage.saveAccountTokens(email, tokens);

    const existingIdx = this.accounts.findIndex((a) => a.email === email);
    if (existingIdx >= 0) {
      this.accounts[existingIdx].name = name || this.accounts[existingIdx].name;
      this.accounts[existingIdx].status = 'active';
      this.accounts[existingIdx].isBanned = false;
      this.accounts[existingIdx].statusMessage = undefined;
    } else {
      this.accounts.push({
        id: Buffer.from(email).toString('base64').substring(0, 16),
        email,
        name: name || email.split('@')[0],
        isActive: this.accounts.length === 0,
        addedAt: new Date().toISOString(),
        status: 'active',
        isBanned: false,
        quotas: [],
        averageQuotaPercentage: 0,
        hasWeeklyQuota: false,
        has5HourQuota: false,
        accountType: 'Standard Free',
        tierBadge: 'STANDARD FREE'
      });
    }

    await this.storage.saveAccounts(this.accounts);
    vscode.window.showInformationMessage(`Account ${email} saved successfully!`);
    this._onDidChangeState.fire();
    this.refreshAccountQuota(email, true).catch(() => {});
    return true;
  }

  /**
   * Removes an account.
   */
  public async removeAccount(email: string): Promise<void> {
    const isCurrentActive = this.activeEmail === email;
    this.accounts = this.accounts.filter((a) => a.email !== email);
    await this.storage.saveAccounts(this.accounts);
    await this.storage.removeAccountTokens(email);

    if (isCurrentActive && this.accounts.length > 0) {
      const nextHealthy = this.accounts.find((a) => !a.isBanned && a.status === 'active') || this.accounts[0];
      if (nextHealthy && nextHealthy.status === 'active') {
        await this.switchAccount(nextHealthy.email);
      } else {
        this.activeEmail = undefined;
        await this.storage.setActiveAccountEmail(undefined);
      }
    } else if (this.accounts.length === 0) {
      this.activeEmail = undefined;
      await this.storage.setActiveAccountEmail(undefined);
    }

    vscode.window.showInformationMessage(`Account ${email} removed.`);
    this._onDidChangeState.fire();
  }

  /**
   * Removes multiple accounts simultaneously.
   */
  public async removeMultipleAccounts(emails: string[]): Promise<void> {
    if (!emails || emails.length === 0) return;
    const emailSet = new Set(emails);
    const wasActiveRemoved = this.activeEmail && emailSet.has(this.activeEmail);

    this.accounts = this.accounts.filter((a) => !emailSet.has(a.email));
    await this.storage.saveAccounts(this.accounts);

    for (const email of emails) {
      await this.storage.removeAccountTokens(email);
    }

    if (wasActiveRemoved && this.accounts.length > 0) {
      const nextHealthy = this.accounts.find((a) => !a.isBanned && a.status === 'active') || this.accounts[0];
      if (nextHealthy && nextHealthy.status === 'active') {
        await this.switchAccount(nextHealthy.email);
      } else {
        this.activeEmail = undefined;
        await this.storage.setActiveAccountEmail(undefined);
      }
    } else if (this.accounts.length === 0) {
      this.activeEmail = undefined;
      await this.storage.setActiveAccountEmail(undefined);
    }

    vscode.window.showInformationMessage(`Removed ${emails.length} account(s).`);
    this._onDidChangeState.fire();
  }

  /**
   * Refreshes quota balances for multiple selected accounts with fast pacing delays.
   */
  public async refreshMultipleAccounts(emails: string[], onProgress?: (current: number, total: number, email: string) => void): Promise<void> {
    if (!emails || emails.length === 0) return;
    const batchSize = EXTENSION_DEFAULTS.REFRESH_BATCH_SIZE;
    const pacingDelayMs = EXTENSION_DEFAULTS.BATCH_PACING_DELAY_MS;
    const total = emails.length;
    let completedCount = 0;

    for (let i = 0; i < total; i += batchSize) {
      const chunk = emails.slice(i, i + batchSize);
      await Promise.all(
        chunk.map(async (email) => {
          try {
            await this.refreshAccountQuota(email);
          } catch (err) {
            console.warn(`[Antigravity Swap] Failed to refresh account ${email}:`, err);
          } finally {
            completedCount++;
            if (onProgress) {
              onProgress(completedCount, total, email);
            }
          }
        })
      );

      this.storage.renewRefreshLease();

      if (i + batchSize < total && pacingDelayMs > 0) {
        await new Promise((r) => setTimeout(r, pacingDelayMs));
      }
    }

    await this.checkAutoSwitch();
    this._onDidChangeState.fire();
  }

  /**
   * Refreshes quota balances for all accounts with credentials.
   * Prioritizes the active account first, followed by remaining accounts in parallel batch chunks.
   * Uses distributed lease and periodically renews the lease during batch execution.
   */
  public async refreshAllQuotas(force = false, onProgress?: (current: number, total: number, email: string) => void): Promise<void> {
    if (!this.storage.tryAcquireRefreshLease(force)) {
      console.log('[Antigravity Swap] Refresh skipped (lease held or in cooldown). Reloading accounts from shared storage.');
      await this.reloadFromStorage();
      return;
    }

    const batchSize = EXTENSION_DEFAULTS.REFRESH_BATCH_SIZE;
    const pacingDelayMs = EXTENSION_DEFAULTS.BATCH_PACING_DELAY_MS;

    try {
      const active = this.getActiveAccount();
      // Prioritize active account first for instant UI response
      const orderedAccounts = [
        ...(active ? [active] : []),
        ...this.accounts.filter((a) => a.email !== active?.email)
      ];

      const total = orderedAccounts.length;
      let completedCount = 0;

      for (let i = 0; i < total; i += batchSize) {
        const chunk = orderedAccounts.slice(i, i + batchSize);
        await Promise.all(
          chunk.map(async (acc) => {
            try {
              await this.refreshAccountQuota(acc.email);
            } catch (err) {
              console.warn(`[Antigravity Swap] Failed to refresh account ${acc.email}:`, err);
            } finally {
              completedCount++;
              if (onProgress) {
                onProgress(completedCount, total, acc.email);
              }
            }
          })
        );

        this.storage.renewRefreshLease();

        // Pacing delay between batch chunks to prevent API rate limits
        if (i + batchSize < total && pacingDelayMs > 0) {
          await new Promise((r) => setTimeout(r, pacingDelayMs));
        }
      }

      await this.checkAutoSwitch();
      this._onDidChangeState.fire();
    } finally {
      this.storage.releaseRefreshLease();
    }
  }

  public async refreshAccountQuota(email: string, force = false): Promise<void> {
    const acc = this.accounts.find((a) => a.email === email);
    if (!acc) return;

    // Silent per-account rate limiting: skip network request if refreshed within cooldown
    const now = Date.now();
    if (!force && acc.lastRefreshedAt) {
      const lastRefreshed = new Date(acc.lastRefreshedAt).getTime();
      if (!isNaN(lastRefreshed) && now - lastRefreshed < EXTENSION_DEFAULTS.ACCOUNT_REFRESH_COOLDOWN_MS) {
        return;
      }
    }

    // Set early in-flight timestamp to prevent concurrent double-triggers
    acc.lastRefreshedAt = new Date().toISOString();

    const tokens = await this.storage.getAccountTokens(email);
    if (!tokens || !tokens.accessToken) {
      acc.status = 'auth_failed';
      acc.statusMessage = 'Credentials missing. Re-login required.';
      acc.quotas = [];
      acc.averageQuotaPercentage = 0;
      acc.fiveHourQuotaPercentage = undefined;
      acc.weeklyQuotaPercentage = undefined;
      await this.storage.saveAccounts(this.accounts);
      this._onDidChangeState.fire();
      return;
    }

    try {
      const res = await this.quotaService.fetchAccountQuotas(acc, tokens, async (newTokens) => {
        await this.storage.saveAccountTokens(email, newTokens);
      });

      acc.quotas = res.quotas;
      acc.quotaGroups = res.quotaGroups;
      acc.geminiGroup = res.geminiGroup;
      acc.claudeGptGroup = res.claudeGptGroup;
      acc.averageQuotaPercentage = res.averagePercentage;
      acc.fiveHourQuotaPercentage = res.fiveHourPercentage;
      acc.weeklyQuotaPercentage = res.weeklyPercentage;
      acc.fiveHourResetTime = res.fiveHourResetTime;
      acc.fiveHourResetCountdown = res.fiveHourResetCountdown;
      acc.weeklyResetTime = res.weeklyResetTime;
      acc.weeklyResetCountdown = res.weeklyResetCountdown;
      acc.has5HourQuota = res.has5HourQuota;
      acc.hasWeeklyQuota = res.hasWeeklyQuota;
      acc.accountType = res.accountType;
      acc.tierBadge = res.tierBadge;
      acc.status = res.status;
      acc.isBanned = res.isBanned;
      acc.banReason = res.isBanned ? res.statusMessage : undefined;
      acc.statusMessage = res.statusMessage;
      acc.lastRefreshedAt = new Date().toISOString();
      acc.lastHeartbeatAt = new Date().toISOString();

      await this.storage.saveAccounts(this.accounts);
      this._onDidChangeState.fire();
    } catch (err) {
      console.warn(`[Antigravity Swap] Error refreshing quota for ${email}:`, err);
    }
  }

  /**
   * Heartbeat execution: polls active account quota and checks background account status.
   * Checks the distributed lease so multiple instances do not spam Google APIs simultaneously.
   */
  public async runHeartbeatTick(): Promise<void> {
    // Keep active state synchronized with IDE external login/logout
    await this.checkExternalIdeSession().catch(() => {});

    // Try to acquire distributed lease for background heartbeat polling
    if (!this.storage.tryAcquireRefreshLease(false)) {
      // Another instance recently refreshed or is in progress; reload shared data
      await this.reloadFromStorage();
      await this.checkAutoSwitch();
      return;
    }

    try {
      // Find candidate accounts eligible for background refresh (exclude banned or auth failed accounts)
      const candidateAccounts = this.accounts.filter(
        (a) => !a.isBanned && a.status !== 'banned' && a.status !== 'auth_failed'
      );

      if (candidateAccounts.length > 0) {
        // Pick the single account that has gone the longest without a refresh (oldest lastRefreshedAt or never refreshed)
        const sorted = [...candidateAccounts].sort((a, b) => {
          const tA = a.lastRefreshedAt ? new Date(a.lastRefreshedAt).getTime() : 0;
          const tB = b.lastRefreshedAt ? new Date(b.lastRefreshedAt).getTime() : 0;
          return tA - tB;
        });

        const target = sorted[0];
        if (target) {
          await this.refreshAccountQuota(target.email);
        }
      }

      await this.checkAutoSwitch();
    } finally {
      this.storage.releaseRefreshLease();
    }
  }

  /**
   * Resolves the quota percentage for an account based on selected target:
   * - 'total': uses averageQuotaPercentage.
   * - 'gemini': uses Weekly quota for Free accounts, or 5-Hour window for Pro/Ultra accounts.
   * - 'claude': uses Weekly quota for Free accounts, or 5-Hour window for Pro/Ultra accounts.
   */
  public getAccountTargetQuota(account: AccountInfo, target: AutoSwitchTarget = 'total'): number {
    if (target === 'total') {
      return account.averageQuotaPercentage ?? 0;
    }

    const isFree = !account.tierBadge || account.tierBadge === 'STANDARD FREE' || account.accountType?.toLowerCase().includes('free') === true;
    const quotas = account.quotas || [];
    const fiveHourQuotas = quotas.filter((q) => q.windowType === '5h' && !q.disabled && q.percentage >= 0);
    const weeklyQuotas = quotas.filter((q) => q.windowType === 'weekly' && !q.disabled && q.percentage >= 0);

    if (target === 'gemini') {
      const geminiGroup = account.geminiGroup || account.quotaGroups?.find((g) => g.id === 'gemini' || g.name.toLowerCase().includes('gemini'));
      const geminiWeekly = geminiGroup?.weekly || weeklyQuotas.find((q) => q.displayName.toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('pro'));
      const gemini5h = geminiGroup?.fiveHour || fiveHourQuotas.find((q) => q.displayName.toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('flash'));

      if (isFree) {
        if (geminiWeekly && !geminiWeekly.disabled && geminiWeekly.percentage >= 0) {
          return geminiWeekly.percentage;
        }
        if (gemini5h && !gemini5h.disabled && gemini5h.percentage >= 0) {
          return gemini5h.percentage;
        }
        return account.weeklyQuotaPercentage ?? account.averageQuotaPercentage ?? 0;
      } else {
        if (gemini5h && !gemini5h.disabled && gemini5h.percentage >= 0) {
          return gemini5h.percentage;
        }
        if (geminiWeekly && !geminiWeekly.disabled && geminiWeekly.percentage >= 0) {
          return geminiWeekly.percentage;
        }
        return account.fiveHourQuotaPercentage ?? account.averageQuotaPercentage ?? 0;
      }
    }

    if (target === 'claude') {
      const claudeGroup = account.claudeGptGroup || account.quotaGroups?.find((g) => g.id === 'claude_gpt' || g.name.toLowerCase().includes('claude') || g.name.toLowerCase().includes('gpt'));
      const claudeWeekly = claudeGroup?.weekly || weeklyQuotas.find((q) => q.displayName.toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('gpt'));
      const claude5h = claudeGroup?.fiveHour || fiveHourQuotas.find((q) => q.displayName.toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('gpt'));

      if (isFree) {
        if (claudeWeekly && !claudeWeekly.disabled && claudeWeekly.percentage >= 0) {
          return claudeWeekly.percentage;
        }
        if (claude5h && !claude5h.disabled && claude5h.percentage >= 0) {
          return claude5h.percentage;
        }
        return account.weeklyQuotaPercentage ?? account.averageQuotaPercentage ?? 0;
      } else {
        if (claude5h && !claude5h.disabled && claude5h.percentage >= 0) {
          return claude5h.percentage;
        }
        if (claudeWeekly && !claudeWeekly.disabled && claudeWeekly.percentage >= 0) {
          return claudeWeekly.percentage;
        }
        return account.fiveHourQuotaPercentage ?? account.averageQuotaPercentage ?? 0;
      }
    }

    return account.averageQuotaPercentage ?? 0;
  }

  /**
   * Resolves the protection quota percentage for an account based on selected target:
   * - 'total': returns the account's total quota percentage (averageQuotaPercentage).
   * - 'gemini': returns the account's weekly Gemini quota percentage (if tracked).
   * - 'claude': returns the account's weekly Claude & GPT quota percentage (if tracked).
   * Returns undefined if no relevant quota is tracked.
   */
  public getAccountProtectionQuota(account: AccountInfo, target: AutoSwitchTarget = 'total'): number | undefined {
    if (target === 'total') {
      return account.averageQuotaPercentage ?? 0;
    }

    const quotas = account.quotas || [];
    const weeklyQuotas = quotas.filter((q) => q.windowType === 'weekly' && !q.disabled && q.percentage >= 0);

    if (target === 'gemini') {
      const geminiGroup = account.geminiGroup || account.quotaGroups?.find((g) => g.id === 'gemini' || g.name.toLowerCase().includes('gemini'));
      const geminiWeekly = geminiGroup?.weekly || weeklyQuotas.find((q) => q.displayName.toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('pro'));
      if (geminiWeekly && !geminiWeekly.disabled && geminiWeekly.percentage >= 0) {
        return geminiWeekly.percentage;
      }
      if (account.weeklyQuotaPercentage !== undefined && !account.claudeGptGroup?.weekly) {
        return account.weeklyQuotaPercentage;
      }
      return undefined;
    }

    if (target === 'claude') {
      const claudeGroup = account.claudeGptGroup || account.quotaGroups?.find((g) => g.id === 'claude_gpt' || g.name.toLowerCase().includes('claude') || g.name.toLowerCase().includes('gpt'));
      const claudeWeekly = claudeGroup?.weekly || weeklyQuotas.find((q) => q.displayName.toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('gpt'));
      if (claudeWeekly && !claudeWeekly.disabled && claudeWeekly.percentage >= 0) {
        return claudeWeekly.percentage;
      }
      if (account.weeklyQuotaPercentage !== undefined && !account.geminiGroup?.weekly) {
        return account.weeklyQuotaPercentage;
      }
      return undefined;
    }

    return undefined;
  }

  /**
   * Auto-switches to next account with healthy quota if current account is exhausted or unusable.
   * If autoSwitch is turned OFF, it NEVER auto-switches under any circumstance.
   * Includes protection layer: triggers switch if target model weekly quota (or total quota) drops to or below protectionThreshold.
   */
  public async checkAutoSwitch(): Promise<void> {
    const autoSwitch = this.storage.getAutoSwitchEnabled();
    if (!autoSwitch) return;

    const active = this.getActiveAccount();
    if (!active) return;

    const isAuthFailed = active.status === 'auth_failed';
    const isBanned = active.isBanned || active.status === 'banned';

    // If account credentials are ok, wait until quota data is loaded before evaluating low quota
    if (!isAuthFailed && !isBanned) {
      if (!active.lastRefreshedAt || !active.quotas || active.quotas.length === 0) {
        return;
      }
    }

    const threshold = this.getAutoSwitchThreshold();
    const target = this.getAutoSwitchTarget();
    const protectionThreshold = this.getWeeklyQuotaProtectionThreshold();

    const activeQuota = this.getAccountTargetQuota(active, target);
    const isDepleted = activeQuota <= threshold;
    const isUnusable = isAuthFailed || isBanned;

    // Protection layer: when weekly quota of target model (or total quota if target === 'total') drops to or below protectionThreshold
    const activeProtectionQuota = this.getAccountProtectionQuota(active, target);
    const isProtectionTriggered = activeProtectionQuota !== undefined && activeProtectionQuota <= protectionThreshold;

    if (isDepleted || isProtectionTriggered || isUnusable) {
      const targetLabel = target === 'gemini' ? 'Gemini' : target === 'claude' ? 'Claude & GPT' : 'Total';
      const protectionMetricName = target === 'total' ? 'total quota' : `weekly ${targetLabel} quota`;

      // Find candidates that have healthy quota for this target and are not near protection limit
      const candidates = this.accounts.filter((a) => {
        if (a.email === active.email || a.isBanned || a.status !== 'active') return false;
        // Primary target quota must be strictly above threshold
        if (this.getAccountTargetQuota(a, target) <= threshold) return false;
        // Protection layer: candidate's protection quota (weekly for gemini/claude, total for total) must also be above protectionThreshold
        const candProt = this.getAccountProtectionQuota(a, target);
        if (candProt !== undefined && candProt <= protectionThreshold) return false;
        return true;
      });

      // Best candidate: sort descending by that target's quota, breaking ties with protection quota
      candidates.sort((a, b) => {
        const diff = this.getAccountTargetQuota(b, target) - this.getAccountTargetQuota(a, target);
        if (diff !== 0) return diff;
        const bProt = this.getAccountProtectionQuota(b, target) ?? 0;
        const aProt = this.getAccountProtectionQuota(a, target) ?? 0;
        return bProt - aProt;
      });

      const candidate = candidates[0];

      if (candidate) {
        const candidateQuota = this.getAccountTargetQuota(candidate, target);
        const candidateProtQuota = this.getAccountProtectionQuota(candidate, target);

        let reason: string;
        if (isAuthFailed) {
          reason = 'authentication failed (token expired/invalid)';
        } else if (isBanned) {
          reason = 'account suspended/banned by Google';
        } else if (isProtectionTriggered && !isDepleted) {
          reason = `${protectionMetricName} dropped to ${activeProtectionQuota}% (<= ${protectionThreshold}% protection limit)`;
        } else {
          reason = `low ${targetLabel} quota (${activeQuota}%)`;
        }

        const candidateDetails = (candidateProtQuota !== undefined && target !== 'total')
          ? `${targetLabel}: ${candidateQuota}%, weekly: ${candidateProtQuota}%`
          : `${targetLabel}: ${candidateQuota}%`;

        vscode.window.showWarningMessage(
          `Account ${active.email} has ${reason}. Auto-switching to ${candidate.email} (${candidateDetails} left)...`
        );
        await this.switchAccount(candidate.email);
      }
    }
  }

  /**
   * Auto-discovers existing accounts on local machine and adds them.
   */
  public async importDetectedAccounts(): Promise<number> {
    const discovered = await this.storage.discoverExistingAccounts();
    let addedCount = 0;

    const currentSession = await this.storage.getCurrentAntigravityAccount();

    for (const disc of discovered) {
      const exists = this.accounts.find((a) => a.email === disc.email);
      const isCurrentSession = currentSession?.email === disc.email;
      const hasToken = !!disc.accessToken;

      if (!exists) {
        this.accounts.push({
          id: Buffer.from(disc.email).toString('base64').substring(0, 16),
          email: disc.email,
          name: disc.name,
          avatarUrl: disc.avatarUrl,
          isActive: isCurrentSession,
          addedAt: new Date().toISOString(),
          status: hasToken ? 'active' : 'auth_failed',
          statusMessage: hasToken ? 'Discovered' : 'Click Re-login to authenticate',
          isBanned: false,
          quotas: [],
          averageQuotaPercentage: 0,
          hasWeeklyQuota: false,
          has5HourQuota: false,
          accountType: 'Standard Free',
          tierBadge: 'STANDARD FREE'
        });
        addedCount++;

        if (disc.accessToken) {
          await this.storage.saveAccountTokens(disc.email, {
            accessToken: disc.accessToken,
            refreshToken: disc.refreshToken
          });
        }
      }
    }

    if (addedCount > 0) {
      if (currentSession?.email) {
        this.activeEmail = currentSession.email;
        await this.storage.setActiveAccountEmail(this.activeEmail);
      }
      await this.storage.saveAccounts(this.accounts);
      this._onDidChangeState.fire();
    }

    return addedCount;
  }
}
