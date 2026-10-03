import * as vscode from 'vscode';
import { AccountInfo, OAuthTokens, OverallQuotaSummary } from './types';
import { StorageService } from './storage';
import { OAuthService } from './oauthService';
import { QuotaService } from './quotaService';
import { CONFIG_KEYS, EXTENSION_DEFAULTS } from './constants';

export class AccountManager {
  private accounts: AccountInfo[] = [];
  private activeEmail?: string;
  private readonly _onDidChangeState = new vscode.EventEmitter<void>();
  public readonly onDidChangeState = this._onDidChangeState.event;

  constructor(
    private readonly storage: StorageService,
    private readonly oauthService: OAuthService,
    private readonly quotaService: QuotaService
  ) {}

  public async initialize(): Promise<void> {
    this.accounts = this.storage.getAccounts();

    // Listen to IDE window focus to instantly catch external logins/logouts in the IDE
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) {
        this.syncCurrentAccountFromIde().catch(() => {});
      }
    });

    // Sync state with current IDE session
    await this.syncCurrentAccountFromIde();

    // Auto-discover previous accounts from system if list is empty
    if (this.accounts.length === 0) {
      await this.importDetectedAccounts();
    }

    // Initial quota check only for accounts with valid tokens
    await this.refreshAllQuotas().catch((err) => console.warn('[Antigravity Swap] Initial quota refresh failed:', err));

    // ONLY auto-switch if auto-switch is explicitly enabled by user
    if (this.isAutoSwitchEnabled()) {
      await this.checkAutoSwitch();
    }
  }

  /**
   * Syncs active account status from the IDE's internal state.vscdb
   */
  public async syncCurrentAccountFromIde(): Promise<void> {
    const currentSession = await this.storage.getCurrentAntigravityAccount().catch(() => null);
    const ideEmail = currentSession?.email;

    if (!ideEmail) {
      if (this.activeEmail !== undefined) {
        this.activeEmail = undefined;
        this.accounts = this.accounts.map((a) => ({ ...a, isActive: false }));
        await this.storage.saveAccounts(this.accounts);
        await this.storage.setActiveAccountEmail(undefined);
        this._onDidChangeState.fire();
      }
      return;
    }

    const existingAcc = this.accounts.find((a) => a.email === ideEmail);

    if (!existingAcc) {
      // User logged into an account in IDE that is NOT in the extension's list.
      // Rule: Do NOT auto-import it. Only clear active status so no extension account is active.
      if (this.activeEmail !== undefined || this.accounts.some((a) => a.isActive)) {
        console.log(`[Antigravity Swap] Current IDE account (${ideEmail}) is not in extension list. Deactivating extension accounts.`);
        this.activeEmail = undefined;
        this.accounts = this.accounts.map((a) => ({ ...a, isActive: false }));
        await this.storage.saveAccounts(this.accounts);
        await this.storage.setActiveAccountEmail(undefined);
        this._onDidChangeState.fire();
      }
      return;
    }

    // Account is in extension list: sync changes and update active status
    let changed = false;
    if (currentSession.accessToken) {
      const existingTokens = await this.storage.getAccountTokens(ideEmail);
      const tokens: OAuthTokens = {
        accessToken: currentSession.accessToken,
        refreshToken: currentSession.refreshToken || existingTokens?.refreshToken,
        expiresAt: Date.now() + 3600 * 1000
      };
      await this.storage.saveAccountTokens(ideEmail, tokens);
    }

    if (currentSession.name && existingAcc.name !== currentSession.name) {
      existingAcc.name = currentSession.name;
      changed = true;
    }
    if (currentSession.avatarUrl && existingAcc.avatarUrl !== currentSession.avatarUrl) {
      existingAcc.avatarUrl = currentSession.avatarUrl;
      changed = true;
    }

    if (this.activeEmail !== ideEmail || !existingAcc.isActive) {
      this.activeEmail = ideEmail;
      this.accounts = this.accounts.map((a) => ({
        ...a,
        isActive: a.email === ideEmail,
        lastUsedAt: a.email === ideEmail ? new Date().toISOString() : a.lastUsedAt
      }));
      changed = true;
    }

    if (changed) {
      await this.storage.saveAccounts(this.accounts);
      await this.storage.setActiveAccountEmail(ideEmail);
      this._onDidChangeState.fire();
    }
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
      const choice = await vscode.window.showErrorMessage(
        `Cannot switch: Account ${email} authentication failed / credentials expired. Re-login now?`,
        'Re-login Account',
        'Cancel'
      );
      if (choice === 'Re-login Account') {
        await this.reloginAccount(email);
      }
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

      const reloginChoice = await vscode.window.showWarningMessage(
        `Cannot switch: Credentials missing or expired for ${email}. Re-login now?`,
        'Re-login Account',
        'Cancel'
      );
      if (reloginChoice === 'Re-login Account') {
        await this.reloginAccount(email);
      }
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

        const rechoice = await vscode.window.showErrorMessage(
          `Cannot switch: Credentials for ${email} expired. Please re-login.`,
          'Re-login Now',
          'Cancel'
        );
        if (rechoice === 'Re-login Now') {
          await this.reloginAccount(email);
        }
        return false;
      }
    }

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

    // 3. Update IDE state database (state.vscdb) and cloud agent DB in-place
    await this.storage.syncToIdeStateDb(target, tokens);
    await this.storage.syncToCloudAccountsDb(email);

    // 4. Hot-restart the Antigravity Language Server in the background so it immediately picks up new credentials without closing IDE
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
    if (!current || !current.email || !current.accessToken) {
      vscode.window.showWarningMessage('No active Antigravity session with valid access token found in state database.');
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
    await this.storage.setActiveAccountEmail(this.activeEmail);

    vscode.window.showInformationMessage(`Successfully imported active account ${current.email} from Antigravity IDE!`);
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
    // Check if user changed login/logout in IDE externally
    await this.syncCurrentAccountFromIde();

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
