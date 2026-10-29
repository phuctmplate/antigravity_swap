import * as vscode from 'vscode';
import { AccountInfo, OverallQuotaSummary, AutoSwitchTarget } from '../types';
import { StorageService } from '../storage';
import { OAuthService } from '../auth';
import { QuotaService } from '../quota';
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
    // Synchronously preload accounts and activeEmail from in-memory globalState (0ms)
    const rawAccounts = this.storage.getAccounts();
    this.accounts = rawAccounts.filter((a) => this.storage.isValidEmail(a.email));
    this.activeEmail = this.storage.getActiveAccountEmail();

    const notifyStateChange = () => this._onDidChangeState.fire();

    this.switcher = new AccountSwitcher(this.storage, this.oauthService, {
      getAccounts: () => this.accounts,
      setAccounts: (accs) => { this.accounts = accs; },
      getActiveEmail: () => this.activeEmail,
      setActiveEmail: (email) => { this.activeEmail = email; },
      notifyStateChange,
      onPostSwitch: (email) => {
        this.quotaService.invalidateLanguageServerConnection();
        this.quotaSync.refreshAccountQuota(email, true).catch(() => {});
      }

    });

    this.autoSwitcher = new AccountAutoSwitcher(this.storage, {
      getAccounts: () => this.accounts,
      getActiveAccount: () => this.getActiveAccount(),
      switchAccount: (email) => this.switchAccount(email),
      addAccountViaOAuth: () => this.addAccountViaOAuth(),
      probeCandidate: async (email: string) => {
        const tokens = await this.storage.getAccountTokens(email);
        if (!tokens?.accessToken) {
          return { ok: false, isDepleted: true, error: 'Tokens missing' };
        }
        const acc = this.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
        if (!acc) return { ok: false, isDepleted: true, error: 'Account not found' };
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
      getLiveLanguageServerEmail: () => this.quotaService.getLiveLanguageServerEmail(),
      switchAccount: (email) => this.switchAccount(email),
      refreshAccountQuota: (email, force) => this.refreshAccountQuota(email, force),
      isSwitching: () => this.switcher.isSwitchInProgress(),
      isAutoSwitching: () => this.autoSwitcher.isAutoSwitchInProgress(),
      notifyStateChange
    });
  }

  public async initialize(): Promise<void> {
    const rawAccounts = this.storage.getAccounts();
    this.accounts = rawAccounts.filter((a) => this.storage.isValidEmail(a.email));
    if (this.accounts.length !== rawAccounts.length) {
      await this.storage.saveAccounts(this.accounts);
      console.log(`[Antigravity Swap] Sanitized ${rawAccounts.length - this.accounts.length} invalid/phantom account(s).`);
    }

    // 1. Probe live running Language Server first (definitive ground truth of the active IDE session)
    let liveLsEmail: string | undefined;
    try {
      liveLsEmail = await this.quotaService.getLiveLanguageServerEmail();
    } catch {}

    // 2. Read stored active IDE session from SQLite / storage
    const currentSession = await this.storage.getCurrentAntigravityAccount().catch(() => null);
    const activeDetectedEmail = (liveLsEmail && this.storage.isValidEmail(liveLsEmail))
      ? liveLsEmail.trim().toLowerCase()
      : (currentSession?.email && this.storage.isValidEmail(currentSession.email))
        ? currentSession.email.trim().toLowerCase()
        : undefined;

    if (!activeDetectedEmail) {
      // IDE is currently logged out!
      this.activeEmail = undefined;
      this.accounts = this.accounts.map((a) => ({ ...a, isActive: false }));
      await this.storage.setActiveAccountEmail(undefined);
    } else {
      // Priority:
      // 1. Live Language Server email (if matching an account in this.accounts)
      // 2. savedActive (if matching an account in this.accounts)
      // 3. activeDetectedEmail
      const savedActive = this.storage.getActiveAccountEmail()?.toLowerCase();
      const effectiveEmail = (liveLsEmail && this.accounts.some((a) => a.email.toLowerCase() === liveLsEmail.toLowerCase()))
        ? liveLsEmail.toLowerCase()
        : (savedActive && this.accounts.some((a) => a.email.toLowerCase() === savedActive))
          ? savedActive
          : (this.accounts.some((a) => a.email.toLowerCase() === activeDetectedEmail))
            ? activeDetectedEmail
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
      if (this.quotaSync.isBackgroundRefreshingState()) {
        return;
      }
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

    // Initial quota check respects distributed lease & freshness threshold (force=false)
    await this.refreshAllQuotas(false).catch((err) => console.warn('[Antigravity Swap] Initial quota refresh failed:', err));

    // ONLY auto-switch if auto-switch is explicitly enabled by user AND quotas were loaded
    if (this.isAutoSwitchEnabled()) {
      await this.checkAutoSwitch();
    }
  }

  public async reloadFromStorage(): Promise<void> {
    const rawAccounts = this.storage.getAccounts();
    const cleanAccounts = rawAccounts.filter((a) => this.storage.isValidEmail(a.email));
    this.accounts = cleanAccounts;
    const active = this.storage.getActiveAccountEmail();
    this.activeEmail = (active && this.accounts.some((a) => a.email === active)) ? active : this.accounts.find((a) => a.isActive)?.email;
    this._onDidChangeState.fire();
  }

  public handleConfigurationChange(): void {
    this._onDidChangeState.fire();
    if (this.isAutoSwitchEnabled()) {
      this.checkAutoSwitch().catch(() => {});
    }
  }

  public async handleIdeSessionChange(): Promise<void> {
    return this.lifecycle.handleIdeSessionChange();
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

  public async switchAccount(email: string, isManual = false, isSilent = false): Promise<boolean> {
    if (isManual) {
      this.lifecycle.recordManualSwitch();
    }
    const ok = await this.switcher.switchAccount(email, isManual, isSilent);
    if (ok) {
      this.autoSwitcher.clearFailedCandidate(email);
    }
    return ok;
  }

  public async reloginAccount(email: string): Promise<boolean> {
    return this.lifecycle.reloginAccount(email);
  }

  public async importCurrentAntigravityAccount(): Promise<AccountInfo | null> {
    return this.lifecycle.importCurrentAntigravityAccount();
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

  public async importDetectedAccounts(): Promise<number> {
    return this.lifecycle.importDetectedAccounts();
  }
}
