import * as vscode from 'vscode';
import { AccountInfo, OAuthTokens } from '../types';
import { StorageService } from '../storage';
import { OAuthService } from '../auth';
import { EXTENSION_DEFAULTS } from '../constants';

export interface AccountLifecycleContext {
  getAccounts: () => AccountInfo[];
  setAccounts: (accounts: AccountInfo[]) => void;
  getActiveEmail: () => string | undefined;
  setActiveEmail: (email: string | undefined) => void;
  switchAccount: (email: string) => Promise<boolean>;
  refreshAccountQuota: (email: string, force?: boolean) => Promise<void>;
  notifyStateChange: () => void;
}

/**
 * AccountLifecycle
 * Manages adding accounts (OAuth and manual token entry), re-authentication,
 * account removals, IDE session synchronization, and account discovery import.
 */
export class AccountLifecycle {
  private isImporting = false;
  private lastImportTime = 0;
  private static readonly IMPORT_COOLDOWN_MS = EXTENSION_DEFAULTS.IMPORT_COOLDOWN_MS;

  private lastOAuthTime = 0;
  private static readonly OAUTH_COOLDOWN_MS = EXTENSION_DEFAULTS.OAUTH_COOLDOWN_MS;

  constructor(
    private readonly storage: StorageService,
    private readonly oauthService: OAuthService,
    private readonly ctx: AccountLifecycleContext
  ) {}

  /**
   * Handles real-time IDE auth session changes (login / logout / switch).
   */
  public async handleIdeSessionChange(): Promise<void> {
    await new Promise((r) => setTimeout(r, 150));

    const currentSession = await this.storage.getCurrentAntigravityAccount().catch(() => null);
    const accounts = this.ctx.getAccounts();
    const activeEmail = this.ctx.getActiveEmail();

    if (!currentSession || !currentSession.email || !this.storage.isValidEmail(currentSession.email) || !currentSession.accessToken) {
      // IDE is logged out!
      if (activeEmail !== undefined || accounts.some((a) => a.isActive)) {
        console.log('[Antigravity Swap] Detected IDE logout: clearing active account selection.');
        this.ctx.setActiveEmail(undefined);
        const updated = accounts.map((a) => ({ ...a, isActive: false }));
        this.ctx.setAccounts(updated);
        await this.storage.setActiveAccountEmail(undefined);
        await this.storage.saveAccounts(updated);
        this.ctx.notifyStateChange();
      }
      return;
    }

    // IDE is logged in to a valid account!
    const email = currentSession.email.trim().toLowerCase();
    const existingAcc = accounts.find((a) => a.email.toLowerCase() === email);

    if (existingAcc) {
      const existingTokens = await this.storage.getAccountTokens(existingAcc.email);
      const isTokenDifferent = !existingTokens || (currentSession.accessToken && currentSession.accessToken !== existingTokens.accessToken);
      const isAlreadyActive = activeEmail?.toLowerCase() === email && existingAcc.isActive;

      if (!isAlreadyActive || isTokenDifferent) {
        // Update tokens
        const tokens: OAuthTokens = {
          accessToken: currentSession.accessToken,
          refreshToken: currentSession.refreshToken || existingTokens?.refreshToken,
          expiresAt: Date.now() + 3600 * 1000
        };
        await this.storage.saveAccountTokens(existingAcc.email, tokens);

        // Set active
        this.ctx.setActiveEmail(existingAcc.email);
        const updated = accounts.map((a) => ({
          ...a,
          isActive: a.email.toLowerCase() === email,
          status: a.email.toLowerCase() === email ? 'healthy' : a.status,
          statusMessage: a.email.toLowerCase() === email ? undefined : a.statusMessage,
          name: (a.email.toLowerCase() === email && currentSession.name) ? currentSession.name : a.name,
          avatarUrl: (a.email.toLowerCase() === email && currentSession.avatarUrl) ? currentSession.avatarUrl : a.avatarUrl
        }));
        this.ctx.setAccounts(updated);
        await this.storage.setActiveAccountEmail(existingAcc.email);
        await this.storage.saveAccounts(updated);
        this.ctx.notifyStateChange();
        console.log(`[Antigravity Swap] Synchronized active account to ${existingAcc.email} following IDE login.`);
      }
    } else {
      // Current IDE session is not in extension: clear active flag on extension accounts
      if (activeEmail !== undefined) {
        this.ctx.setActiveEmail(undefined);
        const updated = accounts.map((a) => ({ ...a, isActive: false }));
        this.ctx.setAccounts(updated);
        await this.storage.setActiveAccountEmail(undefined);
        await this.storage.saveAccounts(updated);
        this.ctx.notifyStateChange();
      }
    }
  }

  /**
   * Re-authenticates / reconnects a specific account by launching Google browser login.
   */
  public async reloginAccount(email: string): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastOAuthTime < AccountLifecycle.OAUTH_COOLDOWN_MS) {
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

      const accounts = this.ctx.getAccounts();
      const existingIdx = accounts.findIndex((a) => a.email === userInfo.email || a.email === email);
      if (existingIdx >= 0) {
        accounts[existingIdx] = {
          ...accounts[existingIdx],
          email: userInfo.email,
          name: userInfo.name || accounts[existingIdx].name,
          avatarUrl: userInfo.avatarUrl || accounts[existingIdx].avatarUrl,
          status: 'healthy',
          isBanned: false,
          banReason: undefined,
          statusMessage: undefined,
          lastUsedAt: new Date().toISOString()
        };
      } else {
        accounts.push({
          id: Buffer.from(userInfo.email).toString('base64').substring(0, 16),
          email: userInfo.email,
          name: userInfo.name,
          avatarUrl: userInfo.avatarUrl,
          isActive: false,
          addedAt: new Date().toISOString(),
          status: 'healthy',
          isBanned: false,
          statusMessage: undefined,
          quotas: [],
          averageQuotaPercentage: undefined,
          hasWeeklyQuota: false,
          has5HourQuota: false,
          accountType: 'Standard Free',
          tierBadge: 'STANDARD FREE'
        });
      }

      await this.storage.saveAccounts(accounts);
      this.storage.broadcastOAuthCompleted(userInfo.email);
      vscode.window.showInformationMessage(`Re-authenticated ${userInfo.email} successfully!`);
      this.ctx.notifyStateChange();

      await this.ctx.refreshAccountQuota(userInfo.email, true).catch(() => {});

      const activeEmail = this.ctx.getActiveEmail();
      if (activeEmail === userInfo.email || activeEmail === email) {
        await this.ctx.switchAccount(userInfo.email);
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
    if (this.isImporting || (now - this.lastImportTime < AccountLifecycle.IMPORT_COOLDOWN_MS)) {
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

      const accounts = this.ctx.getAccounts();
      const existingIdx = accounts.findIndex((a) => a.email === current.email);
      let account: AccountInfo;

      if (existingIdx >= 0) {
        account = {
          ...accounts[existingIdx],
          name: current.name || accounts[existingIdx].name,
          avatarUrl: current.avatarUrl || accounts[existingIdx].avatarUrl,
          status: 'healthy',
          isBanned: false,
          statusMessage: undefined,
          isActive: true,
          lastUsedAt: new Date().toISOString()
        };
        accounts[existingIdx] = account;
      } else {
        account = {
          id: Buffer.from(current.email).toString('base64').substring(0, 16),
          email: current.email,
          name: current.name,
          avatarUrl: current.avatarUrl,
          isActive: true,
          addedAt: new Date().toISOString(),
          status: 'healthy',
          isBanned: false,
          statusMessage: undefined,
          quotas: [],
          averageQuotaPercentage: undefined,
          hasWeeklyQuota: false,
          has5HourQuota: false,
          accountType: 'Standard Free',
          tierBadge: 'STANDARD FREE'
        };
        accounts.push(account);
      }

      // Set other accounts isActive = false
      const updated = accounts.map((a) => ({
        ...a,
        isActive: a.email === current.email
      }));
      this.ctx.setAccounts(updated);
      this.ctx.setActiveEmail(current.email);

      await this.storage.saveAccounts(updated);
      if (existingIdx >= 0) {
        vscode.window.showInformationMessage(`Account ${current.email} is already in the list.`);
      } else {
        vscode.window.showInformationMessage(`Successfully imported new account ${current.email} from Antigravity IDE!`);
      }
      this.ctx.notifyStateChange();

      await this.ctx.refreshAccountQuota(current.email, true).catch(() => {});
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
    if (now - this.lastOAuthTime < AccountLifecycle.OAUTH_COOLDOWN_MS) {
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

      const accounts = this.ctx.getAccounts();
      const existingIdx = accounts.findIndex((a) => a.email === userInfo.email);
      let account: AccountInfo;

      if (existingIdx >= 0) {
        account = {
          ...accounts[existingIdx],
          name: userInfo.name || accounts[existingIdx].name,
          avatarUrl: userInfo.avatarUrl || accounts[existingIdx].avatarUrl,
          status: 'healthy',
          isBanned: false,
          lastUsedAt: new Date().toISOString()
        };
        accounts[existingIdx] = account;
      } else {
        account = {
          id: Buffer.from(userInfo.email).toString('base64').substring(0, 16),
          email: userInfo.email,
          name: userInfo.name,
          avatarUrl: userInfo.avatarUrl,
          isActive: accounts.length === 0,
          addedAt: new Date().toISOString(),
          status: 'healthy',
          isBanned: false,
          quotas: [],
          averageQuotaPercentage: undefined,
          hasWeeklyQuota: false,
          has5HourQuota: false,
          accountType: 'Standard Free',
          tierBadge: 'STANDARD FREE'
        };
        accounts.push(account);
      }

      await this.storage.saveAccounts(accounts);
      this.storage.broadcastOAuthCompleted(userInfo.email);
      if (account.isActive) {
        await this.ctx.switchAccount(account.email);
      }

      vscode.window.showInformationMessage(`Added account ${userInfo.email} to Antigravity Swap!`);
      this.ctx.notifyStateChange();

      await this.ctx.refreshAccountQuota(account.email, true).catch(() => {});
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

    const accounts = this.ctx.getAccounts();
    const existingIdx = accounts.findIndex((a) => a.email === email);
    if (existingIdx >= 0) {
      accounts[existingIdx].name = name || accounts[existingIdx].name;
      accounts[existingIdx].status = 'healthy';
      accounts[existingIdx].isBanned = false;
      accounts[existingIdx].statusMessage = undefined;
    } else {
      accounts.push({
        id: Buffer.from(email).toString('base64').substring(0, 16),
        email,
        name: name || email.split('@')[0],
        isActive: accounts.length === 0,
        addedAt: new Date().toISOString(),
        status: 'healthy',
        isBanned: false,
        quotas: [],
        averageQuotaPercentage: undefined,
        hasWeeklyQuota: false,
        has5HourQuota: false,
        accountType: 'Standard Free',
        tierBadge: 'STANDARD FREE'
      });
    }

    await this.storage.saveAccounts(accounts);
    vscode.window.showInformationMessage(`Account ${email} saved successfully!`);
    this.ctx.notifyStateChange();
    await this.ctx.refreshAccountQuota(email, true).catch(() => {});
    return true;
  }

  /**
   * Removes an account.
   */
  public async removeAccount(email: string, isSilent = false): Promise<void> {
    const isCurrentActive = this.ctx.getActiveEmail() === email;
    const remaining = this.ctx.getAccounts().filter((a) => a.email !== email);
    this.ctx.setAccounts(remaining);
    await this.storage.saveAccounts(remaining);
    await this.storage.removeAccountTokens(email);

    if (isCurrentActive && remaining.length > 0) {
      const nextHealthy = remaining.find((a) => !a.isBanned && (a.status === 'healthy' || a.status === 'active')) || remaining[0];
      if (nextHealthy && (nextHealthy.status === 'healthy' || nextHealthy.status === 'active')) {
        await this.ctx.switchAccount(nextHealthy.email);
      } else {
        this.ctx.setActiveEmail(undefined);
        await this.storage.setActiveAccountEmail(undefined);
      }
    } else if (remaining.length === 0) {
      this.ctx.setActiveEmail(undefined);
      await this.storage.setActiveAccountEmail(undefined);
    }

    if (!isSilent) {
      vscode.window.showInformationMessage(`Account ${email} removed.`);
    }
    this.ctx.notifyStateChange();
  }

  /**
   * Removes multiple accounts simultaneously.
   */
  public async removeMultipleAccounts(emails: string[], isSilent = false): Promise<void> {
    if (!emails || emails.length === 0) return;
    const emailSet = new Set(emails);
    const activeEmail = this.ctx.getActiveEmail();
    const wasActiveRemoved = activeEmail && emailSet.has(activeEmail);

    const remaining = this.ctx.getAccounts().filter((a) => !emailSet.has(a.email));
    this.ctx.setAccounts(remaining);
    await this.storage.saveAccounts(remaining);

    for (const email of emails) {
      await this.storage.removeAccountTokens(email);
    }

    if (wasActiveRemoved && remaining.length > 0) {
      const nextHealthy = remaining.find((a) => !a.isBanned && (a.status === 'healthy' || a.status === 'active')) || remaining[0];
      if (nextHealthy && (nextHealthy.status === 'healthy' || nextHealthy.status === 'active')) {
        await this.ctx.switchAccount(nextHealthy.email);
      } else {
        this.ctx.setActiveEmail(undefined);
        await this.storage.setActiveAccountEmail(undefined);
      }
    } else if (remaining.length === 0) {
      this.ctx.setActiveEmail(undefined);
      await this.storage.setActiveAccountEmail(undefined);
    }

    if (!isSilent) {
      vscode.window.showInformationMessage(`Removed ${emails.length} account(s).`);
    }
    this.ctx.notifyStateChange();
  }

  /**
   * Auto-discovers existing accounts on local machine and adds them.
   */
  public async importDetectedAccounts(): Promise<number> {
    const discovered = await this.storage.discoverExistingAccounts();
    let addedCount = 0;

    const currentSession = await this.storage.getCurrentAntigravityAccount();
    const accounts = this.ctx.getAccounts();

    for (const disc of discovered) {
      const exists = accounts.find((a) => a.email === disc.email);
      const isCurrentSession = currentSession?.email === disc.email;
      const hasToken = !!disc.accessToken;

      if (!exists) {
        accounts.push({
          id: Buffer.from(disc.email).toString('base64').substring(0, 16),
          email: disc.email,
          name: disc.name,
          avatarUrl: disc.avatarUrl,
          isActive: isCurrentSession,
          addedAt: new Date().toISOString(),
          status: hasToken ? 'healthy' : 'auth_failed',
          statusMessage: hasToken ? 'Discovered' : 'Click Re-login to authenticate',
          isBanned: false,
          quotas: [],
          averageQuotaPercentage: undefined,
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
        this.ctx.setActiveEmail(currentSession.email);
        await this.storage.setActiveAccountEmail(currentSession.email);
      }
      await this.storage.saveAccounts(accounts);
      this.ctx.notifyStateChange();
    }

    return addedCount;
  }
}
