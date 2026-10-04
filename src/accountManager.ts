import * as vscode from 'vscode';
import { AccountInfo, OAuthTokens, OverallQuotaSummary } from './types';
import { StorageService } from './storage';
import { OAuthService } from './oauthService';
import { QuotaService } from './quotaService';
import { CONFIG_KEYS, EXTENSION_DEFAULTS } from './constants';

export class AccountManager {
  private accounts: AccountInfo[] = [];
  private activeEmail?: string;
  private isSwitching = false;
  private lastSwitchTime = 0;
  private static readonly SWITCH_COOLDOWN_MS = 2000;
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

    // Listen to IDE window focus to sync IDE session changes
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) {
        this.handleIdeSessionChange().catch(() => {});
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
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Antigravity Swap: Opening browser to authenticate ${email}...`,
          cancellable: true
        },
        async () => {
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
      vscode.window.showInformationMessage(`Re-authenticated ${userInfo.email} successfully!`);
      this._onDidChangeState.fire();

      await this.refreshAccountQuota(userInfo.email).catch(() => {});

      if (this.activeEmail === userInfo.email || this.activeEmail === email) {
        await this.switchAccount(userInfo.email);
      }

      return true;
    } catch (err: any) {
      vscode.window.showErrorMessage(`Re-login error: ${err.message}`);
      return false;
    }
  }

  /**
   * Imports or updates the account currently logged into Antigravity IDE.
   */
  public async importCurrentAntigravityAccount(): Promise<AccountInfo | null> {
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
      console.log(`[Antigravity Swap] Updated credentials and quota for ${current.email} from IDE session.`);
    } else {
      vscode.window.showInformationMessage(`Successfully imported new account ${current.email} from Antigravity IDE!`);
    }
    this._onDidChangeState.fire();

    this.refreshAccountQuota(current.email).catch(() => {});
    return account;
  }

  /**
   * Adds an account via Google OAuth web authorization.
   */
  public async addAccountViaOAuth(): Promise<AccountInfo | null> {
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Antigravity Swap: Opening browser to authenticate with Google...',
          cancellable: true
        },
        async () => {
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
      if (account.isActive) {
        await this.switchAccount(account.email);
      }

      vscode.window.showInformationMessage(`Added account ${userInfo.email} to Antigravity Swap!`);
      this._onDidChangeState.fire();

      this.refreshAccountQuota(account.email).catch(() => {});
      return account;
    } catch (err: any) {
      vscode.window.showErrorMessage(`Login failed: ${err.message}`);
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
    this.refreshAccountQuota(email).catch(() => {});
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
   * Refreshes quota balances for multiple selected accounts.
   */
  public async refreshMultipleAccounts(emails: string[]): Promise<void> {
    if (!emails || emails.length === 0) return;
    for (const email of emails) {
      await this.refreshAccountQuota(email);
    }
    await this.checkAutoSwitch();
    this._onDidChangeState.fire();
  }

  /**
   * Refreshes quota balances for all accounts with credentials.
   */
  public async refreshAllQuotas(): Promise<void> {
    for (const acc of this.accounts) {
      await this.refreshAccountQuota(acc.email);
    }
    await this.checkAutoSwitch();
    this._onDidChangeState.fire();
  }

  public async refreshAccountQuota(email: string): Promise<void> {
    const acc = this.accounts.find((a) => a.email === email);
    if (!acc) return;

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
  }

  /**
   * Heartbeat execution: polls active account quota and checks background account status.
   */
  public async runHeartbeatTick(): Promise<void> {
    // Keep active state synchronized with IDE external login/logout
    await this.checkExternalIdeSession().catch(() => {});

    const active = this.getActiveAccount();
    if (active) {
      await this.refreshAccountQuota(active.email);
    }

    // Also check one background account per tick in round-robin fashion
    const bgAccounts = this.accounts.filter((a) => a.email !== active?.email && a.status === 'active');
    if (bgAccounts.length > 0) {
      const oldestSynced = bgAccounts.sort((a, b) => {
        const tA = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : 0;
        const tB = b.lastHeartbeatAt ? new Date(b.lastHeartbeatAt).getTime() : 0;
        return tA - tB;
      })[0];
      if (oldestSynced) {
        await this.refreshAccountQuota(oldestSynced.email);
      }
    }

    await this.checkAutoSwitch();
  }

  /**
   * Auto-switches to next account with healthy quota if current account is exhausted or banned.
   */
  public async checkAutoSwitch(): Promise<void> {
    const autoSwitch = this.storage.getAutoSwitchEnabled();
    if (!autoSwitch) return;

    const active = this.getActiveAccount();
    if (!active) return;

    // Do not auto-switch if quota data hasn't been fetched yet
    if (!active.lastRefreshedAt || !active.quotas || active.quotas.length === 0) {
      return;
    }

    const config = vscode.workspace.getConfiguration(CONFIG_KEYS.SECTION);
    const threshold = config.get<number>(CONFIG_KEYS.LOW_QUOTA_THRESHOLD, EXTENSION_DEFAULTS.DEFAULT_LOW_QUOTA_THRESHOLD_PERCENT);

    const isDepleted = active.averageQuotaPercentage <= threshold;
    const isUnusable = active.isBanned || active.status === 'auth_failed' || active.status === 'banned';

    if (isDepleted || isUnusable) {
      const candidate = this.accounts.find(
        (a) => a.email !== active.email && !a.isBanned && a.status === 'active' && a.averageQuotaPercentage > threshold
      );

      if (candidate) {
        const reason = isUnusable ? 'account credentials/ban status' : `low quota (${active.averageQuotaPercentage}%)`;
        vscode.window.showWarningMessage(
          `Account ${active.email} has ${reason}. Auto-switching to ${candidate.email} (${candidate.averageQuotaPercentage}% left)...`
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
