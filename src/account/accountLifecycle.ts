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
  getIdeSessionEmail?: () => string | undefined;
  setIdeSessionEmail?: (email: string | undefined) => void;
  getLiveLanguageServerEmail?: () => Promise<string | undefined>;
  switchAccount: (email: string, isManual?: boolean, isSilent?: boolean, force?: boolean) => Promise<boolean>;
  refreshAccountQuota: (email: string, force?: boolean) => Promise<void>;
  reloadFromStorage?: () => Promise<void>;
  isSwitching?: () => boolean;
  isAutoSwitching?: () => boolean;
  isHotSyncing?: () => boolean;
  notifyStateChange: () => void;
}

/**
 * AccountLifecycle
 * Manages adding accounts (OAuth and manual token entry), re-authentication,
 * account removals, and asymmetric IDE session synchronization (Model A+).
 */
export class AccountLifecycle {
  private lastOAuthTime = 0;
  private static readonly OAUTH_COOLDOWN_MS = EXTENSION_DEFAULTS.OAUTH_COOLDOWN_MS;
  private lastManualSwitchTime = 0;
  private lastSwitchTargetEmail: string | undefined;
  private sessionCheckInFlight: Promise<void> | null = null;

  constructor(
    private readonly storage: StorageService,
    private readonly oauthService: OAuthService,
    private readonly ctx: AccountLifecycleContext
  ) {}

  public recordManualSwitch(targetEmail?: string): void {
    this.lastManualSwitchTime = Date.now();
    this.lastSwitchTargetEmail = targetEmail ? targetEmail.trim().toLowerCase() : undefined;
  }

  /**
   * Records a startup or cross-window hot-sync settle cooldown without flagging any account as a
   * manual switch target (so subsequent user sign-outs are never misread as IDE rejections).
   */
  public recordSessionSyncCooldown(): void {
    this.lastManualSwitchTime = Date.now();
    this.lastSwitchTargetEmail = undefined;
  }

  private async refreshIdeHintFromLiveState(): Promise<void> {
    if (typeof this.storage.getLiveIdeAuthState !== 'function') return;
    try {
      const liveState = await this.storage.getLiveIdeAuthState();
      if (liveState.authState === 'signedIn' && liveState.email && this.storage.isValidEmail(liveState.email)) {
        this.ctx.setIdeSessionEmail?.(liveState.email);
      } else if (liveState.authState === 'signedOut') {
        this.ctx.setIdeSessionEmail?.(undefined);
      }
      this.ctx.notifyStateChange();
    } catch {}
  }

  /**
   * Handles real-time IDE auth session changes using Asymmetric Sync (Model A+):
   * - Never auto-activates or imports accounts when the user has not explicitly clicked Switch.
   * - Tracks the live IDE email as an informational hint (for the IN IDE card badge).
   * - Releases extension active control if the user manually signs out or switches accounts inside the IDE UI.
   */
  public async handleIdeSessionChange(options?: { fastPoll?: boolean }): Promise<void> {
    if (this.sessionCheckInFlight) {
      return this.sessionCheckInFlight;
    }

    const promise = this.executeIdeSessionCheck(options).finally(() => {
      if (this.sessionCheckInFlight === promise) {
        this.sessionCheckInFlight = null;
      }
    });
    this.sessionCheckInFlight = promise;
    return promise;
  }

  private async executeIdeSessionCheck(options?: { fastPoll?: boolean }): Promise<void> {
    const fastPoll = Boolean(options?.fastPoll);
    const msSinceSwitch = Date.now() - this.lastManualSwitchTime;

    // Guard against race conditions during active switches (local or another IDE window) or hot-syncing
    if (
      this.ctx.isSwitching?.() ||
      this.ctx.isAutoSwitching?.() ||
      this.ctx.isHotSyncing?.() ||
      this.storage.hasSwitchInProgress?.() ||
      this.storage.hasRecentSwitchEvent?.(3000)
    ) {
      if (!fastPoll) {
        console.log('[AccountLifecycle] Switch or hot-sync in progress. Ignoring IDE session flutter.');
      }
      return;
    }

    if (!fastPoll) {
      await new Promise((r) => setTimeout(r, 150));

      // Re-check recent external switch after short settle delay to avoid clobbering another window's switch
      if (this.storage.hasSwitchInProgress?.() || this.storage.hasRecentSwitchEvent?.(3000)) {
        await this.ctx.reloadFromStorage?.().catch(() => {});
        return;
      }
    }

    let liveState = typeof this.storage.getLiveIdeAuthState === 'function'
      ? await this.storage
          .getLiveIdeAuthState({ skipDiskFallback: true, forceServerRefresh: false })
          .catch(() => ({ authState: 'unknown' as const, email: undefined }))
      : { authState: 'unknown' as const, email: undefined };

    // Suppress signedIn account flutter for 15s after a manual switch, EXCEPT allow explicit signedOut after 2.5s
    // so late IDE session rejections (showing the Login prompt) release active control and flag NOT VERIFIED.
    const isWithinFullCooldown = msSinceSwitch < 15000 || Boolean(this.storage.hasRecentSwitchEvent?.(15000));
    if (isWithinFullCooldown && !(liveState.authState === 'signedOut' && msSinceSwitch >= 2500)) {
      if (!fastPoll) {
        console.log('[AccountLifecycle] Recent switch guard active. Ignoring IDE session flutter.');
      }
      return;
    }

    const activeEmailBefore = this.ctx.getActiveEmail();
    const prevIdeEmail = this.ctx.getIdeSessionEmail?.();
    const rawProbeEmail = liveState.email?.trim().toLowerCase();
    const validProbeEmail = rawProbeEmail && this.storage.isValidEmail(rawProbeEmail) ? rawProbeEmail : undefined;

    // Zero-overhead early exit on steady-state fast polls when live IDE auth matches current extension state
    if (fastPoll) {
      const noChangeSignedIn =
        liveState.authState === 'signedIn' &&
        validProbeEmail &&
        prevIdeEmail?.toLowerCase() === validProbeEmail &&
        (!activeEmailBefore || activeEmailBefore.toLowerCase() === validProbeEmail);
      const noChangeSignedOut =
        liveState.authState === 'signedOut' &&
        !activeEmailBefore &&
        !prevIdeEmail;

      if (liveState.authState === 'unknown' || noChangeSignedIn || noChangeSignedOut) {
        return;
      }

      // Potential external IDE state transition detected during fast poll:
      // Wait 150ms settle and re-confirm live IDE state before mutating active control.
      await new Promise((r) => setTimeout(r, 150));
      if (
        this.ctx.isSwitching?.() ||
        this.ctx.isAutoSwitching?.() ||
        this.ctx.isHotSyncing?.()
      ) {
        return;
      }
      if (this.storage.hasSwitchInProgress?.() || this.storage.hasRecentSwitchEvent?.(3000)) {
        await this.ctx.reloadFromStorage?.().catch(() => {});
        return;
      }

      if (liveState.authState === 'signedOut' && typeof this.storage.getLiveIdeAuthState === 'function') {
        liveState = await this.storage
          .getLiveIdeAuthState({ skipDiskFallback: true, forceServerRefresh: false })
          .catch(() => liveState);
        if (liveState.authState === 'unknown') {
          return;
        }
      }
    }

    let liveLsEmail: string | undefined;
    try {
      liveLsEmail = await this.ctx.getLiveLanguageServerEmail?.();
    } catch {}

    const accounts = this.ctx.getAccounts();
    const activeEmail = this.ctx.getActiveEmail();
    const rawEmail = liveLsEmail?.trim().toLowerCase() || validProbeEmail;
    const validLiveEmail = rawEmail && this.storage.isValidEmail(rawEmail) ? rawEmail : undefined;

    const latestPrevIdeEmail = this.ctx.getIdeSessionEmail?.();
    let nextIdeEmail = latestPrevIdeEmail;
    if (liveState.authState === 'signedOut') {
      nextIdeEmail = undefined;
    } else if (validLiveEmail) {
      nextIdeEmail = validLiveEmail;
    }

    const ideEmailChanged = nextIdeEmail !== latestPrevIdeEmail;
    if (ideEmailChanged) {
      this.ctx.setIdeSessionEmail?.(nextIdeEmail);
    }

    // Before mutating active state, verify disk accounts haven't already shifted via another IDE window
    const diskAccounts = this.storage.getAccounts();
    const diskActiveEmail = diskAccounts.find((a) => a.isActive)?.email;
    if ((diskActiveEmail || undefined) !== activeEmail) {
      await this.ctx.reloadFromStorage?.().catch(() => {});
      return;
    }

    // 1. If extension does NOT own an active account yet, never auto-activate from IDE.
    //    Simply notify UI so the IN IDE badge reflects the latest IDE login state.
    if (!activeEmail) {
      if (ideEmailChanged) {
        this.ctx.notifyStateChange();
      }
      return;
    }

    // 2. Extension already owns an active account: detect manual IDE sign-out, delayed IDE rejection, or manual IDE account switch.
    if (liveState.authState === 'signedOut') {
      const explicitRejectionMsg = liveState.rejectionMessage?.trim();
      const wasRecentlySwitchedTarget =
        Boolean(explicitRejectionMsg) &&
        this.lastSwitchTargetEmail === activeEmail.toLowerCase() &&
        Date.now() - this.lastManualSwitchTime < 15000;

      if (wasRecentlySwitchedTarget) {
        console.warn(`[AccountLifecycle] IDE rejected session shortly after switching to ${activeEmail}: ${explicitRejectionMsg}`);
      } else {
        console.log(`[AccountLifecycle] Detected manual IDE sign-out while ${activeEmail} was active. Releasing active selection.`);
      }

      this.lastSwitchTargetEmail = undefined;
      this.ctx.setActiveEmail(undefined);
      const updated = accounts.map((a) => {
        if (wasRecentlySwitchedTarget && a.email.toLowerCase() === activeEmail.toLowerCase()) {
          return {
            ...a,
            isActive: false,
            status: 'auth_failed' as const,
            needsReauth: true,
            hasRequiredScopes: false,
            statusMessage: explicitRejectionMsg || 'IDE rejected account session (not verified). Click Re-login to verify.'
          };
        }
        return { ...a, isActive: false };
      });
      this.ctx.setAccounts(updated);
      await this.storage.setActiveAccountEmail(undefined);
      await this.storage.saveAccounts(updated);
      this.ctx.notifyStateChange();
      return;
    }

    if (validLiveEmail && validLiveEmail !== activeEmail.toLowerCase()) {
      console.log(
        `[AccountLifecycle] Detected manual IDE account change (${activeEmail} -> ${validLiveEmail}). Releasing extension active control.`
      );
      this.ctx.setActiveEmail(undefined);
      const updated = accounts.map((a) => ({ ...a, isActive: false }));
      this.ctx.setAccounts(updated);
      await this.storage.setActiveAccountEmail(undefined);
      await this.storage.saveAccounts(updated);
      this.ctx.notifyStateChange();
      return;
    }

    if (ideEmailChanged) {
      this.ctx.notifyStateChange();
    }
  }

  /**
   * Re-authenticates / reconnects a specific account by launching Google browser login.
   */
  public async reloginAccount(email: string, isSilent = false): Promise<boolean> {
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
          needsReauth: false,
          hasRequiredScopes: tokens.hasRequiredScopes ?? true,
          missingScopes: undefined,
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
          needsReauth: false,
          hasRequiredScopes: tokens.hasRequiredScopes ?? true,
          missingScopes: undefined,
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
      if (!isSilent) {
        vscode.window.showInformationMessage(`Re-authenticated ${userInfo.email} successfully!`);
      }
      this.ctx.notifyStateChange();

      await this.ctx.refreshAccountQuota(userInfo.email, true).catch(() => {});

      const activeEmail = this.ctx.getActiveEmail();
      if (activeEmail === userInfo.email || activeEmail === email) {
        await this.ctx.switchAccount(userInfo.email, false, isSilent, true);
      }

      return true;
    } catch (err: any) {
      if (!isSilent) {
        const msg = err.message || '';
        if (!msg.toLowerCase().includes('cancel') && !msg.toLowerCase().includes('replace')) {
          vscode.window.showErrorMessage(`Re-login error: ${err.message}`);
        }
      }
      return false;
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
          needsReauth: false,
          hasRequiredScopes: tokens.hasRequiredScopes ?? true,
          missingScopes: undefined,
          isBanned: false,
          banReason: undefined,
          statusMessage: undefined,
          lastUsedAt: new Date().toISOString()
        };
        accounts[existingIdx] = account;
      } else {
        account = {
          id: Buffer.from(userInfo.email).toString('base64').substring(0, 16),
          email: userInfo.email,
          name: userInfo.name,
          avatarUrl: userInfo.avatarUrl,
          isActive: false,
          addedAt: new Date().toISOString(),
          status: 'healthy',
          needsReauth: false,
          hasRequiredScopes: tokens.hasRequiredScopes ?? true,
          missingScopes: undefined,
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

      await this.storage.saveAccounts(accounts);
      this.storage.broadcastOAuthCompleted(userInfo.email);
      await this.refreshIdeHintFromLiveState();

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
        isActive: false,
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
    await this.refreshIdeHintFromLiveState();
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
}
