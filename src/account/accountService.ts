import * as vscode from 'vscode';
import { AccountInfo, OverallQuotaSummary, AutoSwitchTarget } from '../types';
import { StorageService } from '../storage';
import { OAuthService } from '../auth';
import { QuotaService } from '../quota';
import { EXTENSION_DEFAULTS } from '../constants';
import { AccountSwitcher } from './accountSwitcher';
import { AccountAutoSwitcher } from './accountAutoSwitcher';
import { AccountQuotaSync } from './accountQuotaSync';
import { AccountLifecycle } from './accountLifecycle';

/**
 * AccountService
 * Main orchestrator coordinating account switching, lifecycle, quota synchronization,
 * and auto-switching across modular sub-services.
 */
export class AccountService {
  private accounts: AccountInfo[] = [];
  private activeEmail?: string;
  private ideSessionEmail?: string;
  private pendingManualSwitchEmail?: string;
  private isHotSyncingWindow = false;
  private isInitializing = false;
  private lastPassiveQuotaPollAt = 0;
  private reloadDebounceTimer: NodeJS.Timeout | null = null;
  private readonly _onDidChangeState = new vscode.EventEmitter<void>();
  public readonly onDidChangeState = this._onDidChangeState.event;

  private readonly switcher: AccountSwitcher;
  private readonly autoSwitcher: AccountAutoSwitcher;
  private readonly quotaSync: AccountQuotaSync;
  private readonly lifecycle: AccountLifecycle;

  constructor(
    private readonly storage: StorageService,
    private readonly oauthService: OAuthService,
    private readonly quotaService: QuotaService
  ) {
    // Synchronously preload accounts and activeEmail from authoritative accounts list (0ms)
    const rawAccounts = this.storage.getAccounts();
    this.accounts = rawAccounts.filter((a) => this.storage.isValidEmail(a.email));
    this.activeEmail = this.accounts.find((a) => a.isActive)?.email;

    const notifyStateChange = () => this._onDidChangeState.fire();

    this.switcher = new AccountSwitcher(this.storage, this.oauthService, {
      getAccounts: () => this.accounts,
      setAccounts: (accs) => { this.accounts = accs; },
      getActiveEmail: () => this.activeEmail,
      setActiveEmail: (email) => { this.activeEmail = email; },
      setIdeSessionEmail: (email) => { this.ideSessionEmail = email; },
      notifyStateChange,
      onPostSwitch: (email) => {
        this.quotaService.invalidateLanguageServerConnection();
        this.quotaSync.refreshAccountQuota(email, true).catch(() => {});
      }

    });

    this.autoSwitcher = new AccountAutoSwitcher(this.storage, {
      getAccounts: () => this.accounts,
      getActiveAccount: () => this.getActiveAccount(),
      switchAccount: (email: string, isManual?: boolean, isSilent?: boolean, force?: boolean) => this.switchAccount(email, isManual, isSilent, force),
      addAccountViaOAuth: () => this.addAccountViaOAuth(),
      getIdeActiveQuota: () => {
        const activeEmail = this.getActiveAccount()?.email;
        return this.quotaService.fetchActiveAccountQuotaFromIde(2500, true, {
          expectedEmail: activeEmail,
          cacheTtlMs: 5000,
          bypassSharedCache: false
        });
      },
      probeCandidate: async (email: string) => {
        const tokens = await this.storage.getAccountTokens(email);
        if (!tokens?.accessToken) {
          return { ok: false, isDepleted: true, error: 'Tokens missing' };
        }
        const acc = this.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
        if (!acc) return { ok: false, isDepleted: true, error: 'Account not found' };

        // Proactive dynamic scope verification against required IDE scopes
        let hasRequiredScopes = tokens.hasRequiredScopes;
        let missingScopes = tokens.missingScopes;

        if (hasRequiredScopes === undefined) {
          try {
            const scopeRes = await this.oauthService.verifyTokenScopes(tokens.accessToken);
            if (scopeRes.valid) {
              hasRequiredScopes = scopeRes.hasRequiredScopes;
              missingScopes = scopeRes.missingScopes;
              tokens.hasRequiredScopes = hasRequiredScopes;
              tokens.missingScopes = missingScopes;
              tokens.hasAiCode = scopeRes.hasAiCode;
              tokens.scopes = scopeRes.scopes;
              await this.storage.saveAccountTokens(email, tokens);
            } else {
              hasRequiredScopes = true; // Allow JIT probe to handle token refresh if expired
            }
          } catch {
            // Non-fatal if network probe fails; rely on switchAccount fallback
            hasRequiredScopes = true;
          }
        }

        if (hasRequiredScopes === false) {
          const curIdx = this.accounts.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
          if (curIdx >= 0) {
            const updated = [...this.accounts];
            updated[curIdx] = {
              ...updated[curIdx],
              status: 'auth_failed',
              needsReauth: true,
              missingScopes,
              hasRequiredScopes: false,
              statusMessage: 'Re-authorization required. Please sign in again.'
            };
            this.accounts = updated;
            await this.storage.saveAccounts(updated);
            this._onDidChangeState.fire();
          }
          return { ok: false, isDepleted: true, error: 'Re-authorization required' };
        }

        const probeRes = await this.quotaService.probeJitCandidate(acc, tokens, async (newTokens) => {
          await this.storage.saveAccountTokens(email, newTokens);
        });
        if (probeRes.ok && !probeRes.isDepleted) {
          this.autoSwitcher.clearFailedCandidate(email);
        }
        return probeRes;
      },
      onCandidateProbed: async (email: string, probeResult) => {
        const latestAccounts = this.accounts;
        const curIdx = latestAccounts.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
        if (curIdx >= 0) {
          const old = latestAccounts[curIdx];
          const new5h = probeResult.fiveHourPercentage;
          const newWk = probeResult.weeklyPercentage;
          const dropped = (old.fiveHourQuotaPercentage !== undefined && new5h !== undefined && new5h < old.fiveHourQuotaPercentage) ||
                          (old.weeklyQuotaPercentage !== undefined && newWk !== undefined && newWk < old.weeklyQuotaPercentage);

          const updated = [...latestAccounts];
          updated[curIdx] = {
            ...old,
            fiveHourQuotaPercentage: new5h ?? old.fiveHourQuotaPercentage,
            weeklyQuotaPercentage: newWk ?? old.weeklyQuotaPercentage,
            averageQuotaPercentage: new5h ?? newWk ?? old.averageQuotaPercentage,
            fiveHourResetTime: probeResult.resetTime || old.fiveHourResetTime,
            externalActivityDetected: dropped || old.externalActivityDetected,
            lastVerifiedSource: 'jit_guard',
            lastRefreshedAt: new Date().toISOString()
          };
          this.accounts = updated;
          await this.storage.saveAccounts(updated);
          this._onDidChangeState.fire();
        }
      },
      onCandidateDepletedExternally: async (email: string, probeResult) => {
        const latestAccounts = this.accounts;
        const curIdx = latestAccounts.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
        if (curIdx >= 0) {
          const updated = [...latestAccounts];
          updated[curIdx] = {
            ...updated[curIdx],
            fiveHourQuotaPercentage: probeResult.fiveHourPercentage ?? 0,
            weeklyQuotaPercentage: probeResult.weeklyPercentage ?? 0,
            averageQuotaPercentage: probeResult.fiveHourPercentage ?? probeResult.weeklyPercentage ?? 0,
            fiveHourResetTime: probeResult.resetTime || updated[curIdx].fiveHourResetTime,
            status: 'low_balance',
            externalActivityDetected: true,
            lastVerifiedSource: 'jit_guard',
            lastRefreshedAt: new Date().toISOString()
          };
          this.accounts = updated;
          await this.storage.saveAccounts(updated);
          this._onDidChangeState.fire();
        }
      }
    });

    this.quotaSync = new AccountQuotaSync(this.storage, this.quotaService, {
      getAccounts: () => this.accounts,
      setAccounts: (accs) => { this.accounts = accs; },
      getActiveAccount: () => this.getActiveAccount(),
      reloadFromStorage: () => this.reloadFromStorage(),
      checkAutoSwitch: () => this.checkAutoSwitch(),
      checkExternalIdeSession: () => this.checkExternalIdeSession(),
      notifyStateChange
    });

    this.lifecycle = new AccountLifecycle(this.storage, this.oauthService, {
      getAccounts: () => this.accounts,
      setAccounts: (accs) => { this.accounts = accs; },
      getActiveEmail: () => this.activeEmail,
      setActiveEmail: (email) => { this.activeEmail = email; },
      getIdeSessionEmail: () => this.ideSessionEmail,
      setIdeSessionEmail: (email) => { this.ideSessionEmail = email; },
      getLiveLanguageServerEmail: () => this.quotaService.getLiveLanguageServerEmail(),
      switchAccount: (email: string, isManual?: boolean, isSilent?: boolean, force?: boolean) => this.switchAccount(email, isManual, isSilent, force),
      refreshAccountQuota: (email, force) => this.refreshAccountQuota(email, force),
      reloadFromStorage: () => this.reloadFromStorage(),
      isSwitching: () => this.switcher.isSwitchInProgress(),
      isAutoSwitching: () => this.autoSwitcher.isAutoSwitchInProgress(),
      isHotSyncing: () => this.isHotSyncingWindow,
      notifyStateChange
    });
  }

  public getIdeSessionEmail(): string | undefined {
    return this.ideSessionEmail;
  }

  public getSwitchingEmail(): string | undefined {
    return this.switcher.getSwitchingEmail();
  }

  private async refreshIdeSessionEmailHint(): Promise<void> {
    if (typeof this.storage.getLiveIdeAuthState !== 'function') return;
    try {
      const liveIde = await this.storage.getLiveIdeAuthState();
      if (liveIde.authState === 'signedIn' && liveIde.email && this.storage.isValidEmail(liveIde.email)) {
        this.ideSessionEmail = liveIde.email;
      } else if (liveIde.authState === 'signedOut') {
        this.ideSessionEmail = undefined;
      }
    } catch {}
  }

  public async initialize(): Promise<void> {
    this.isInitializing = true;
    try {
      const rawAccounts = this.storage.getAccounts();
    this.accounts = rawAccounts.filter((a) => this.storage.isValidEmail(a.email));
    if (this.accounts.length !== rawAccounts.length) {
      await this.storage.saveAccounts(this.accounts);
      console.log(`[Antigravity Swap] Sanitized ${rawAccounts.length - this.accounts.length} invalid/phantom account(s).`);
    }

    // 1. Resolve active account strictly from extension storage (authoritative isActive in accounts.json)
    const activeInAccounts = this.accounts.find((a) => a.isActive)?.email?.toLowerCase();
    let effectiveEmail = (activeInAccounts && this.accounts.some((a) => a.email.toLowerCase() === activeInAccounts))
      ? activeInAccounts
      : undefined;

    // 2. Inspect live IDE auth state (0ms in-memory) to detect external sign-out or manual IDE account switch (Model A+)
    const liveIde = typeof this.storage.getLiveIdeAuthState === 'function'
      ? await this.storage.getLiveIdeAuthState().catch(() => ({ authState: 'unknown' as const, email: undefined }))
      : { authState: 'unknown' as const, email: undefined };

    if (liveIde.authState === 'signedIn' && liveIde.email && this.storage.isValidEmail(liveIde.email)) {
      this.ideSessionEmail = liveIde.email;
    } else if (liveIde.authState === 'signedOut') {
      this.ideSessionEmail = undefined;
    }

    if (effectiveEmail) {
      const ideSignedOut = liveIde.authState === 'signedOut';
      const ideSwitchedExternally = Boolean(
        liveIde.authState === 'signedIn' &&
        liveIde.email &&
        liveIde.email.toLowerCase() !== effectiveEmail
      );

      if (ideSignedOut || ideSwitchedExternally) {
        console.log(
          `[AccountService] Startup detected external IDE change (${ideSignedOut ? 'signedOut' : `switched to ${liveIde.email}`}) while ${effectiveEmail} was active. Releasing extension active control.`
        );
        effectiveEmail = undefined;
        this.activeEmail = undefined;
        this.accounts = this.accounts.map((a) => ({ ...a, isActive: false }));
        await this.storage.setActiveAccountEmail(undefined);
        await this.storage.saveAccounts(this.accounts);
      }
    }

    if (effectiveEmail) {
      const activeAcc = this.accounts.find((a) => a.email.toLowerCase() === effectiveEmail);
      this.activeEmail = activeAcc?.email || effectiveEmail;
      this.ideSessionEmail = activeAcc?.email?.toLowerCase() || effectiveEmail;
      this.accounts = this.accounts.map((a) => ({
        ...a,
        isActive: a.email.toLowerCase() === effectiveEmail
      }));
      await this.storage.setActiveAccountEmail(this.activeEmail);
      await this.storage.syncGoogleAccountsJson(this.activeEmail);

      if (activeAcc) {
        let tokens = await this.storage.getAccountTokens(activeAcc.email);

        // Pre-refresh token if close to expiry (< 2m) or missing expiry
        if (tokens?.refreshToken && (!tokens.expiresAt || Date.now() > tokens.expiresAt - 120000)) {
          try {
            tokens = await this.oauthService.refreshAccessToken(tokens.refreshToken);
            await this.storage.saveAccountTokens(activeAcc.email, tokens);
          } catch (refErr) {
            console.warn('[AccountService] Token refresh on window startup warning:', refErr);
          }
        }

        if (tokens?.accessToken && !activeAcc.needsReauth && activeAcc.status !== 'auth_failed' && !activeAcc.isBanned && tokens.hasRequiredScopes !== false) {
          this.lifecycle.recordSessionSyncCooldown();
          await this.storage.syncToIdeStateDb(activeAcc, tokens, true).catch(() => {});
          await this.storage.liveSwitchOAuthToken(activeAcc, tokens, true, false, true).catch((e) => {
            console.warn('[AccountService] Initial window liveSwitchOAuthToken warning:', e);
          });
        }
      }
    } else {
      // No active account selected by extension yet (first install, manual unswitch, or released control)
      this.activeEmail = undefined;
      this.accounts = this.accounts.map((a) => ({ ...a, isActive: false }));
      await this.storage.setActiveAccountEmail(undefined);
    }
    } finally {
      this.isInitializing = false;
    }

    // Listen to external accounts storage changes (e.g. from other IDE instances/windows)
    this.storage.onDidAccountsChange(async () => {
      if (this.quotaSync.isBackgroundRefreshingState()) {
        return;
      }
      this.reloadFromStorageDebounced(150);
    });

    // Listen to external account switches completed in other IDE instances/windows
    this.storage.onDidExternalSwitchComplete(async (event) => {
      console.log(`[Antigravity Swap] External switch event received for ${event.email}. Hot-syncing current IDE window.`);
      await this.syncActiveAccountToCurrentWindow(event.email);
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
        this.storage.checkExternalSwitchEvent();
      }
    });

    // Initial quota check respects distributed lease & freshness threshold (force=false)
    await this.refreshAllQuotas(false).catch((err) => console.warn('[Antigravity Swap] Initial quota refresh failed:', err));

    // ONLY auto-switch if auto-switch is explicitly enabled by user AND quotas were loaded
    if (this.isAutoSwitchEnabled()) {
      await this.checkAutoSwitch();
    }
  }

  public reloadFromStorageDebounced(delay = 150): void {
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
    }
    this.reloadDebounceTimer = setTimeout(() => {
      this.reloadFromStorage().catch(() => {});
    }, delay);
  }

  public async reloadFromStorage(): Promise<void> {
    const previousActiveEmail = this.activeEmail;
    const rawAccounts = this.storage.getAccounts();
    const cleanAccounts = rawAccounts.filter((a) => this.storage.isValidEmail(a.email));
    this.accounts = cleanAccounts;

    // Authoritative cross-window active state comes from accounts.json isActive flag
    const activeFromDisk = this.accounts.find((a) => a.isActive)?.email;
    this.activeEmail = activeFromDisk;

    if (this.storage.getActiveAccountEmail() !== this.activeEmail) {
      await this.storage.setActiveAccountEmail(this.activeEmail).catch(() => {});
    }

    if (this.activeEmail) {
      this.ideSessionEmail = this.activeEmail.toLowerCase();
    } else {
      await this.refreshIdeSessionEmailHint();
    }

    this._onDidChangeState.fire();

    // If active account changed externally to a new account, seamlessly hot-sync this IDE window's in-memory session
    if (this.activeEmail && this.activeEmail.toLowerCase() !== previousActiveEmail?.toLowerCase() && !this.switcher.isSwitchInProgress()) {
      console.log(`[AccountService] External switch detected from ${previousActiveEmail} -> ${this.activeEmail}. Hot-syncing current IDE window.`);
      this.syncActiveAccountToCurrentWindow(this.activeEmail).catch(() => {});
    }
  }

  /**
   * Seamlessly hot-syncs the active account credentials and Unified State Sync to the current IDE window
   * when an external switch occurs in another IDE instance.
   */
  public async syncActiveAccountToCurrentWindow(email: string): Promise<boolean> {
    if (this.isHotSyncingWindow || this.switcher.isSwitchInProgress()) {
      return false;
    }
    this.isHotSyncingWindow = true;
    this.lifecycle.recordSessionSyncCooldown();
    try {
      const rawAccounts = this.storage.getAccounts();
      const cleanAccounts = rawAccounts.filter((a) => this.storage.isValidEmail(a.email));
      this.accounts = cleanAccounts;

      const target = this.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
      if (!target) {
        return false;
      }

      // Safeguard: If target account is banned, unauthorized, or suspended, do not inject into USS or trigger refresh!
      if (target.isBanned || target.status === 'banned' || target.needsReauth || target.status === 'auth_failed') {
        console.warn(`[AccountService] Skipping external hot-sync for ${target.email}: account is unauthorized or suspended.`);
        this._onDidChangeState.fire();
        return false;
      }

      // 1. Update internal state for this window
      this.activeEmail = target.email;
      this.accounts = this.accounts.map((a) => ({
        ...a,
        isActive: a.email.toLowerCase() === target.email.toLowerCase(),
        lastUsedAt: a.email.toLowerCase() === target.email.toLowerCase() ? new Date().toISOString() : a.lastUsedAt
      }));

      let tokens = await this.storage.getAccountTokens(target.email);
      if (!tokens || !tokens.accessToken) {
        return false;
      }

      // 2. Pre-refresh token if close to expiry or missing expiry
      if ((!tokens.expiresAt || Date.now() > tokens.expiresAt - 120000) && tokens.refreshToken) {
        try {
          tokens = await this.oauthService.refreshAccessToken(tokens.refreshToken);
          await this.storage.saveAccountTokens(target.email, tokens);
        } catch (err: any) {
          console.warn(`[AccountService] Token refresh during external hot-sync failed: ${err.message}`);
        }
      }

      // 2b. Safeguard: Dynamic scope verification.
      if (tokens.hasRequiredScopes === false) {
        console.warn(`[AccountService] Skipping external hot-sync for ${target.email}: token lacks required scopes.`);
        target.needsReauth = true;
        target.status = 'auth_failed';
        target.hasRequiredScopes = false;
        target.statusMessage = 'Re-authorization required. Please sign in again.';
        await this.storage.saveAccounts(this.accounts);
        this._onDidChangeState.fire();
        return false;
      }

      console.log(`[AccountService] Hot-syncing current IDE window to active account: ${target.email}`);
      this.ideSessionEmail = target.email.toLowerCase();
      // Ensure state.vscdb is also aligned on secondary windows
      if (typeof this.storage.syncToIdeStateDb === 'function') {
        await this.storage.syncToIdeStateDb(target, tokens, true).catch(() => {});
      }

      // Pass skipKeyring = true (originating window wrote it), triggerReconnect = true
      // (triggers clean re-handshake in Language Server with newly injected completed onboarding state, blocking the dialog),
      // and pushOnboarding = true so this window's chat conversation immediately recognizes onboarding as completed.
      await this.storage.liveSwitchOAuthToken(target, tokens, true, true, true);
      this._onDidChangeState.fire();
      return true;
    } catch (err: any) {
      console.warn(`[AccountService] Failed to hot-sync window to ${email}:`, err?.message || err);
      return false;
    } finally {
      this.isHotSyncingWindow = false;
    }
  }

  public handleConfigurationChange(): void {
    this._onDidChangeState.fire();
    if (this.isAutoSwitchEnabled()) {
      this.checkAutoSwitch().catch(() => {});
    }
  }

  public async handleIdeSessionChange(options?: { fastPoll?: boolean }): Promise<void> {
    return this.lifecycle.handleIdeSessionChange(options);
  }

  public async pollIdeSessionFast(): Promise<void> {
    if (
      this.isInitializing ||
      this.switcher.isSwitchInProgress() ||
      this.autoSwitcher.isAutoSwitchInProgress() ||
      this.isHotSyncingWindow
    ) {
      return;
    }
    await this.lifecycle.handleIdeSessionChange({ fastPoll: true });

    if (
      !this.isInitializing &&
      !this.switcher.isSwitchInProgress() &&
      !this.autoSwitcher.isAutoSwitchInProgress() &&
      !this.isHotSyncingWindow &&
      this.activeEmail &&
      Date.now() - this.lastPassiveQuotaPollAt >= EXTENSION_DEFAULTS.IDE_PASSIVE_QUOTA_POLL_MS
    ) {
      this.lastPassiveQuotaPollAt = Date.now();
      await this.quotaSync.syncActiveAccountFromIdeSmart().catch(() => {});
    }
  }

  public async checkExternalIdeSession(): Promise<void> {
    return this.handleIdeSessionChange();
  }

  public async syncCurrentAccountFromIde(): Promise<void> {
    return this.handleIdeSessionChange();
  }

  public getAccounts(): AccountInfo[] {
    return this.accounts;
  }

  public getActiveAccount(): AccountInfo | undefined {
    if (!this.activeEmail) return undefined;
    return this.accounts.find((a) => a.email === this.activeEmail && a.isActive);
  }

  public getOverallSummary(): OverallQuotaSummary {
    return this.quotaService.calculateOverallSummary(this.accounts);
  }

  public isAutoSwitchEnabled(): boolean {
    return this.storage.getAutoSwitchEnabled();
  }

  public async setAutoSwitchEnabled(enabled: boolean): Promise<void> {
    await this.storage.setAutoSwitchEnabled(enabled);
    if (!enabled) {
      this.autoSwitcher.resetDepletionKey();
      this.autoSwitcher.setAwaitingRecovery(false);
    } else {
      this.autoSwitcher.resetDepletionKey();
    }
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

  public async switchAccount(email: string, isManual = false, isSilent = false, force = false): Promise<boolean> {
    const emailLower = email.trim().toLowerCase();
    if (isManual) {
      this.pendingManualSwitchEmail = emailLower;
    }
    this.lifecycle.recordManualSwitch(email);
    const ok = await this.switcher.switchAccount(email, isManual, isSilent, force);
    if (ok) {
      this.ideSessionEmail = emailLower;
      this.lastPassiveQuotaPollAt = Date.now();
      this.pendingManualSwitchEmail = undefined;
      this.autoSwitcher.setAwaitingRecovery(false);
      this.autoSwitcher.clearFailedCandidate(email);
    } else if (isManual) {
      const target = this.accounts.find((a) => a.email.toLowerCase() === emailLower);
      const isAuthFailure = Boolean(target && (target.status === 'auth_failed' || target.needsReauth));
      if (!isAuthFailure) {
        this.pendingManualSwitchEmail = undefined;
      }
    }
    return ok;
  }

  public async reloginAccount(email: string, isSilent = false): Promise<boolean> {
    const emailLower = email.trim().toLowerCase();
    const wasActive = this.activeEmail?.toLowerCase() === emailLower;
    const matchedPendingManualSwitch = this.pendingManualSwitchEmail === emailLower;

    const ok = await this.lifecycle.reloginAccount(email, isSilent);
    if (!ok) {
      return false;
    }

    // Account is verified again: remove quarantine and clear any 2-attempt auto-switch cycle pause.
    this.autoSwitcher.clearFailedCandidate(email);

    if (wasActive) {
      this.pendingManualSwitchEmail = undefined;
      return true;
    }

    if (matchedPendingManualSwitch) {
      this.pendingManualSwitchEmail = undefined;
      await this.switchAccount(email, false, isSilent);
      return true;
    }

    // Re-logged-in standby account does NOT hijack an already healthy active account.
    // Only if Auto-Switch is ON and current active is depleted/unusable (or awaiting recovery after 2 failed candidates)
    // does checkAutoSwitch() re-evaluate the entire pool cleanly.
    if (this.storage.getAutoSwitchEnabled()) {
      await this.autoSwitcher.checkAutoSwitch();
    }

    return true;
  }

  public async addAccountViaOAuth(): Promise<AccountInfo | null> {
    return this.lifecycle.addAccountViaOAuth();
  }

  public async addAccountManually(email: string, accessToken: string, refreshToken?: string, name?: string): Promise<boolean> {
    return this.lifecycle.addAccountManually(email, accessToken, refreshToken, name);
  }

  public async removeAccount(email: string, isSilent = false): Promise<void> {
    return this.lifecycle.removeAccount(email, isSilent);
  }

  public async removeMultipleAccounts(emails: string[], isSilent = false): Promise<void> {
    return this.lifecycle.removeMultipleAccounts(emails, isSilent);
  }

  public async refreshMultipleAccounts(emails: string[], onProgress?: (current: number, total: number, email: string) => void): Promise<void> {
    return this.quotaSync.refreshMultipleAccounts(emails, onProgress);
  }

  public async refreshAllQuotas(force = false, onProgress?: (current: number, total: number, email: string) => void): Promise<void> {
    return this.quotaSync.refreshAllQuotas(force, onProgress);
  }

  public async refreshAccountQuota(email: string, force = false, skipSave = false): Promise<void> {
    await this.quotaSync.refreshAccountQuota(email, force, skipSave);
    const acc = this.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (acc && acc.status === 'healthy') {
      this.autoSwitcher.clearFailedCandidate(email);
    }
  }

  public isBackgroundRefreshingState(): boolean {
    return this.quotaSync.isBackgroundRefreshingState();
  }

  public async runHeartbeatTick(): Promise<void> {
    return this.quotaSync.runHeartbeatTick();
  }

  public getAccountTargetQuota(account: AccountInfo, target: AutoSwitchTarget = 'instant'): number {
    return this.autoSwitcher.getAccountTargetQuota(account, target);
  }

  public async checkAutoSwitch(): Promise<void> {
    return this.autoSwitcher.checkAutoSwitch();
  }

  public async getActiveAccountIdeQuota(
    timeoutMs = 2500,
    options?: { expectedEmail?: string; cacheTtlMs?: number; bypassSharedCache?: boolean; forceRefresh?: boolean }
  ) {
    return this.quotaService.fetchActiveAccountQuotaFromIde(timeoutMs, options?.forceRefresh ?? false, options);
  }
}
