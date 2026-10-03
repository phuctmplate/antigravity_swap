import * as vscode from 'vscode';
import { AccountInfo, OAuthTokens, OverallQuotaSummary } from './types';
import { StorageService } from './storage';
import { OAuthService } from './oauthService';
import { QuotaService } from './quotaService';

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
    this.activeEmail = this.storage.getActiveAccountEmail();

    // Auto-discover previous accounts from system if list is empty
    if (this.accounts.length === 0) {
      await this.importDetectedAccounts();
    }

    // Refresh quotas on init
    this.refreshAllQuotas().catch((err) => console.warn('[Antigravity Swap] Initial quota refresh failed:', err));
  }

  public getAccounts(): AccountInfo[] {
    return this.accounts;
  }

  public getActiveAccount(): AccountInfo | undefined {
    return this.accounts.find((a) => a.email === this.activeEmail) || this.accounts.find((a) => a.isActive);
  }

  public getOverallSummary(): OverallQuotaSummary {
    return this.quotaService.calculateOverallSummary(this.accounts);
  }

  /**
   * Switches to the given account WITHOUT reloading the Antigravity IDE window.
   */
  public async switchAccount(email: string): Promise<boolean> {
    const target = this.accounts.find((a) => a.email === email);
    if (!target) {
      vscode.window.showErrorMessage(`Account ${email} not found in Antigravity Swap.`);
      return false;
    }

    let tokens = await this.storage.getAccountTokens(email);
    if (!tokens || !tokens.accessToken) {
      vscode.window.showWarningMessage(`Credentials missing for ${email}. Please sign in again.`);
      return false;
    }

    // Check if access token is expired and refresh
    if (tokens.expiresAt && Date.now() > tokens.expiresAt - 60000 && tokens.refreshToken) {
      try {
        tokens = await this.oauthService.refreshAccessToken(tokens.refreshToken);
        await this.storage.saveAccountTokens(email, tokens);
      } catch (err: any) {
        console.warn(`[Antigravity Swap] Token refresh failed before switch: ${err.message}`);
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

    // 2. Direct-update IDE state DB (state.vscdb)
    await this.storage.syncToIdeStateDb(target, tokens);

    // 3. Direct-update .antigravity-agent/cloud_accounts.db
    await this.storage.syncToCloudAccountsDb(email);

    // 4. Trigger seamless auth refresh inside Antigravity IDE (NO WINDOW RELOAD NEEDED!)
    try {
      await vscode.commands.executeCommand('antigravity.handleAuthRefresh');
    } catch (err) {
      console.warn('[Antigravity Swap] antigravity.handleAuthRefresh command not available, trying language server restart');
    }

    try {
      await vscode.commands.executeCommand('antigravity.restartLanguageServer');
    } catch (err) {
      // Ignore if command not supported in current environment
    }

    // 5. Notify user with a sleek toast
    vscode.window.showInformationMessage(`⚡ Switched to ${target.name || email} seamlessly without reload!`);

    this._onDidChangeState.fire();

    // Refresh quota for newly active account
    this.refreshAccountQuota(email).catch(() => {});

    return true;
  }

  /**
   * Adds an account via Google OAuth web authorization.
   */
  public async addAccountViaOAuth(): Promise<AccountInfo | null> {
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Antigravity Swap: Authenticating with Google...',
          cancellable: true
        },
        async () => {
          return await this.oauthService.loginWithGoogle();
        }
      );

      const { tokens, userInfo } = result;

      // Save tokens securely in VS Code SecretStorage
      await this.storage.saveAccountTokens(userInfo.email, tokens);

      // Check if account already exists in list
      const existingIdx = this.accounts.findIndex((a) => a.email === userInfo.email);
      let account: AccountInfo;

      if (existingIdx >= 0) {
        account = {
          ...this.accounts[existingIdx],
          name: userInfo.name || this.accounts[existingIdx].name,
          avatarUrl: userInfo.avatarUrl || this.accounts[existingIdx].avatarUrl,
          lastUsedAt: new Date().toISOString()
        };
        this.accounts[existingIdx] = account;
      } else {
        account = {
          id: Buffer.from(userInfo.email).toString('base64').substring(0, 16),
          email: userInfo.email,
          name: userInfo.name,
          avatarUrl: userInfo.avatarUrl,
          isActive: this.accounts.length === 0, // make active if first account
          addedAt: new Date().toISOString(),
          status: 'active',
          quotas: this.quotaService.getDefaultModelQuotas(),
          averageQuotaPercentage: 100
        };
        this.accounts.push(account);
      }

      await this.storage.saveAccounts(this.accounts);
      if (account.isActive) {
        await this.switchAccount(account.email);
      }

      vscode.window.showInformationMessage(`Added account ${userInfo.email} to Antigravity Swap!`);
      this._onDidChangeState.fire();

      // Fetch fresh quota in background
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
    } else {
      this.accounts.push({
        id: Buffer.from(email).toString('base64').substring(0, 16),
        email,
        name: name || email.split('@')[0],
        isActive: this.accounts.length === 0,
        addedAt: new Date().toISOString(),
        status: 'active',
        quotas: this.quotaService.getDefaultModelQuotas(),
        averageQuotaPercentage: 100
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
      await this.switchAccount(this.accounts[0].email);
    } else if (this.accounts.length === 0) {
      this.activeEmail = undefined;
      await this.storage.setActiveAccountEmail(undefined);
    }

    vscode.window.showInformationMessage(`Account ${email} removed.`);
    this._onDidChangeState.fire();
  }

  /**
   * Refreshes quota balances for all accounts.
   */
  public async refreshAllQuotas(): Promise<void> {
    for (const acc of this.accounts) {
      await this.refreshAccountQuota(acc.email);
    }
    this.checkAutoSwitch();
    this._onDidChangeState.fire();
  }

  public async refreshAccountQuota(email: string): Promise<void> {
    const acc = this.accounts.find((a) => a.email === email);
    if (!acc) return;

    const tokens = await this.storage.getAccountTokens(email);
    if (!tokens) return;

    const res = await this.quotaService.fetchAccountQuotas(acc, tokens, async (newTokens) => {
      await this.storage.saveAccountTokens(email, newTokens);
    });

    acc.quotas = res.quotas;
    acc.averageQuotaPercentage = res.averagePercentage;
    acc.lastRefreshedAt = new Date().toISOString();
    acc.status = res.averagePercentage < 15 ? 'low_balance' : 'active';

    await this.storage.saveAccounts(this.accounts);
    this._onDidChangeState.fire();
  }

  /**
   * Auto-switches to next account with healthy quota if current account is exhausted.
   */
  public async checkAutoSwitch(): Promise<void> {
    const autoSwitch = this.storage.getAutoSwitchEnabled();
    if (!autoSwitch) return;

    const active = this.getActiveAccount();
    if (!active) return;

    const config = vscode.workspace.getConfiguration('antigravitySwap');
    const threshold = config.get<number>('lowQuotaThresholdPercent', 10);

    if (active.averageQuotaPercentage <= threshold) {
      const candidate = this.accounts.find((a) => a.email !== active.email && a.averageQuotaPercentage > threshold);
      if (candidate) {
        vscode.window.showWarningMessage(
          `⚠️ Account ${active.email} quota is low (${active.averageQuotaPercentage}%). Auto-switching to ${candidate.email} (${candidate.averageQuotaPercentage}% left)...`
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

    for (const disc of discovered) {
      const exists = this.accounts.find((a) => a.email === disc.email);
      if (!exists) {
        this.accounts.push({
          id: Buffer.from(disc.email).toString('base64').substring(0, 16),
          email: disc.email,
          name: disc.name,
          avatarUrl: disc.avatarUrl,
          isActive: this.accounts.length === 0,
          addedAt: new Date().toISOString(),
          status: 'active',
          quotas: this.quotaService.getDefaultModelQuotas(),
          averageQuotaPercentage: 100
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
      await this.storage.saveAccounts(this.accounts);
      if (!this.activeEmail && this.accounts.length > 0) {
        this.activeEmail = this.accounts[0].email;
        await this.storage.setActiveAccountEmail(this.activeEmail);
      }
      this._onDidChangeState.fire();
    }

    return addedCount;
  }
}
