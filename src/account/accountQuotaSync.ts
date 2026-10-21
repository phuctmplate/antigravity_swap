import { AccountInfo } from '../types';
import { StorageService } from '../storage';
import { QuotaService } from '../quota';
import { EXTENSION_DEFAULTS } from '../constants';

export interface AccountQuotaSyncContext {
  getAccounts: () => AccountInfo[];
  setAccounts: (accounts: AccountInfo[]) => void;
  getActiveAccount: () => AccountInfo | undefined;
  reloadFromStorage: () => Promise<void>;
  checkAutoSwitch: () => Promise<void>;
  checkExternalIdeSession: () => Promise<void>;
  notifyStateChange: () => void;
}

/**
 * AccountQuotaSync
 * Coordinates quota refresh scheduling, batch pacing, background heartbeat execution,
 * and rate-limiting across accounts.
 */
export class AccountQuotaSync {
  private isBackgroundRefreshing = false;
  private readonly refreshingEmails = new Set<string>();

  constructor(
    private readonly storage: StorageService,
    private readonly quotaService: QuotaService,
    private readonly ctx: AccountQuotaSyncContext
  ) {}

  public isBackgroundRefreshingState(): boolean {
    return this.isBackgroundRefreshing;
  }

  /**
   * Checks if an account's quota information is stale (older than freshness threshold).
   */
  public isAccountStale(account: AccountInfo, thresholdMs: number = EXTENSION_DEFAULTS.ACCOUNT_FRESHNESS_THRESHOLD_MS): boolean {
    if (!account.lastRefreshedAt) return true;
    const last = new Date(account.lastRefreshedAt).getTime();
    if (isNaN(last)) return true;
    return (Date.now() - last) >= thresholdMs;
  }

  /**
   * Refreshes quota balance for a single account.
   */
  public async refreshAccountQuota(email: string, force = false, skipSave = false): Promise<void> {
    const accounts = this.ctx.getAccounts();
    const accIdx = accounts.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
    if (accIdx < 0) return;
    const acc = accounts[accIdx];

    // Silent per-account rate limiting: skip network request if refreshed within freshness window
    if (!force && !this.isAccountStale(acc)) {
      return;
    }

    if (this.refreshingEmails.has(email)) {
      return;
    }
    this.refreshingEmails.add(email);
    this.storage.renewRefreshLease();

    try {
      const tokens = await this.storage.getAccountTokens(email);
      if (!tokens || !tokens.accessToken) {
        const latestAccounts = this.ctx.getAccounts();
        const curIdx = latestAccounts.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
        if (curIdx >= 0) {
          const updated = [...latestAccounts];
          updated[curIdx] = {
            ...updated[curIdx],
            status: 'auth_failed',
            statusMessage: 'Credentials missing. Re-login required.',
            quotas: [],
            averageQuotaPercentage: 0,
            fiveHourQuotaPercentage: undefined,
            weeklyQuotaPercentage: undefined
          };
          this.ctx.setAccounts(updated);
          if (!skipSave) {
            await this.storage.saveAccounts(updated);
            this.ctx.notifyStateChange();
          }
        }
        return;
      }

      const previousFiveHour = acc.fiveHourQuotaPercentage;
      const previousWeekly = acc.weeklyQuotaPercentage;
      const wasActive = acc.isActive;

      const res = await this.quotaService.fetchAccountQuotas(acc, tokens, async (newTokens) => {
        await this.storage.saveAccountTokens(email, newTokens);
      });

      const latestAccounts = this.ctx.getAccounts();
      const curIdx = latestAccounts.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
      if (curIdx >= 0) {
        let externalActivity = latestAccounts[curIdx].externalActivityDetected ?? false;

        // Detect external activity on standby accounts: if quota decreased while not active on this machine
        if (!wasActive) {
          const new5h = res.fiveHourPercentage;
          const newWk = res.weeklyPercentage;
          const dropped5h = previousFiveHour !== undefined && new5h !== undefined && new5h < previousFiveHour;
          const droppedWk = previousWeekly !== undefined && newWk !== undefined && newWk < previousWeekly;

          if (dropped5h || droppedWk) {
            externalActivity = true;
            console.log(
              `[AccountQuotaSync] External activity detected for ${email}: quota dropped on another machine (5h: ${previousFiveHour}% -> ${new5h}%, weekly: ${previousWeekly}% -> ${newWk}%).`
            );
          } else if ((new5h !== undefined && new5h > (previousFiveHour ?? 0)) || (newWk !== undefined && newWk > (previousWeekly ?? 0))) {
            externalActivity = false;
          }
        }

        const updated = [...latestAccounts];
        updated[curIdx] = {
          ...updated[curIdx],
          quotas: res.quotas,
          quotaGroups: res.quotaGroups,
          geminiGroup: res.geminiGroup,
          claudeGptGroup: res.claudeGptGroup,
          averageQuotaPercentage: res.averagePercentage,
          fiveHourQuotaPercentage: res.fiveHourPercentage,
          weeklyQuotaPercentage: res.weeklyPercentage,
          fiveHourResetTime: res.fiveHourResetTime,
          fiveHourResetCountdown: res.fiveHourResetCountdown,
          weeklyResetTime: res.weeklyResetTime,
          weeklyResetCountdown: res.weeklyResetCountdown,
          has5HourQuota: res.has5HourQuota,
          hasWeeklyQuota: res.hasWeeklyQuota,
          accountType: res.accountType,
          tierBadge: res.tierBadge,
          status: res.status,
          isBanned: res.isBanned,
          banReason: res.isBanned ? res.statusMessage : undefined,
          statusMessage: res.statusMessage,
          externalActivityDetected: externalActivity,
          lastVerifiedSource: wasActive ? 'language_server' : 'micro_client',
          lastRefreshedAt: new Date().toISOString(),
          lastHeartbeatAt: new Date().toISOString()
        };
        this.ctx.setAccounts(updated);

        if (!skipSave) {
          const merged = this.mergeWithDiskAccounts(updated);
          this.ctx.setAccounts(merged);
          await this.storage.saveAccounts(merged);
          this.ctx.notifyStateChange();
        }
      }
    } catch (err) {
      console.warn(`[Antigravity Swap] Error refreshing quota for ${email}:`, err);
    } finally {
      this.refreshingEmails.delete(email);
    }
  }

  /**
   * Merges freshly fetched account updates into latest disk storage,
   * guaranteeing multi-window safety against lost updates.
   */
  private mergeWithDiskAccounts(refreshedAccounts: AccountInfo[]): AccountInfo[] {
    const diskAccounts = this.storage.getAccounts();
    if (!diskAccounts || diskAccounts.length === 0) {
      return refreshedAccounts;
    }

    const diskMap = new Map<string, AccountInfo>();
    for (const acc of diskAccounts) {
      diskMap.set(acc.email.toLowerCase(), acc);
    }

    for (const ref of refreshedAccounts) {
      const email = ref.email.toLowerCase();
      const existing = diskMap.get(email);
      if (existing) {
        diskMap.set(email, {
          ...existing,
          quotas: ref.quotas,
          quotaGroups: ref.quotaGroups,
          geminiGroup: ref.geminiGroup,
          claudeGptGroup: ref.claudeGptGroup,
          averageQuotaPercentage: ref.averageQuotaPercentage,
          fiveHourQuotaPercentage: ref.fiveHourQuotaPercentage,
          weeklyQuotaPercentage: ref.weeklyQuotaPercentage,
          fiveHourResetTime: ref.fiveHourResetTime,
          fiveHourResetCountdown: ref.fiveHourResetCountdown,
          weeklyResetTime: ref.weeklyResetTime,
          weeklyResetCountdown: ref.weeklyResetCountdown,
          has5HourQuota: ref.has5HourQuota,
          hasWeeklyQuota: ref.hasWeeklyQuota,
          accountType: ref.accountType,
          tierBadge: ref.tierBadge,
          status: ref.status,
          isBanned: ref.isBanned,
          banReason: ref.banReason,
          statusMessage: ref.statusMessage,
          lastRefreshedAt: ref.lastRefreshedAt,
          lastHeartbeatAt: ref.lastHeartbeatAt
        });
      }
    }

    return Array.from(diskMap.values());
  }

  /**
   * Refreshes quota balances for multiple selected accounts with fast pacing delays.
   */
  public async refreshMultipleAccounts(
    emails: string[],
    onProgress?: (current: number, total: number, email: string) => void
  ): Promise<void> {
    if (!emails || emails.length === 0) return;
    const batchSize = EXTENSION_DEFAULTS.FORCE_REFRESH_BATCH_SIZE;
    const pacingDelayMs = EXTENSION_DEFAULTS.BATCH_PACING_DELAY_MS;
    const total = emails.length;
    let completedCount = 0;

    this.isBackgroundRefreshing = true;
    this.ctx.notifyStateChange();
    this.storage.tryAcquireRefreshLease(true);

    try {
      for (let i = 0; i < total; i += batchSize) {
        const chunk = emails.slice(i, i + batchSize);
        await Promise.all(
          chunk.map(async (email) => {
            try {
              await this.refreshAccountQuota(email, true, true);
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

        const merged = this.mergeWithDiskAccounts(this.ctx.getAccounts());
        this.ctx.setAccounts(merged);
        await this.storage.saveAccounts(merged);
        this.ctx.notifyStateChange();

        this.storage.renewRefreshLease();

        if (i + batchSize < total && pacingDelayMs > 0) {
          await new Promise((r) => setTimeout(r, pacingDelayMs));
        }
      }

      await this.ctx.checkAutoSwitch();
    } finally {
      this.storage.releaseRefreshLease();
      this.isBackgroundRefreshing = false;
      this.ctx.notifyStateChange();
    }
  }

  /**
   * Refreshes quota balances for all accounts with credentials.
   * Prioritizes the active account first, followed by remaining accounts in parallel batch chunks.
   * Uses distributed lease and periodically renews the lease during batch execution.
   */
  public async refreshAllQuotas(
    force = false,
    onProgress?: (current: number, total: number, email: string) => void
  ): Promise<void> {
    if (!this.storage.tryAcquireRefreshLease(force)) {
      console.log('[Antigravity Swap] Refresh skipped (lease held or in cooldown). Reloading accounts from shared storage.');
      await this.ctx.reloadFromStorage();
      return;
    }

    const batchSize = EXTENSION_DEFAULTS.FORCE_REFRESH_BATCH_SIZE;
    const pacingDelayMs = EXTENSION_DEFAULTS.BATCH_PACING_DELAY_MS;

    try {
      const active = this.ctx.getActiveAccount();
      const accounts = this.ctx.getAccounts();
      const eligibleAccounts = accounts.filter(
        (a) => !a.isBanned && a.status !== 'banned' && a.status !== 'auth_failed'
      );

      // Prioritize active account first, followed by remaining background accounts sorted oldest first
      const otherEligible = eligibleAccounts.filter(
        (a) => a.email.toLowerCase() !== active?.email.toLowerCase()
      );
      otherEligible.sort((a, b) => {
        const tA = a.lastRefreshedAt ? new Date(a.lastRefreshedAt).getTime() : 0;
        const tB = b.lastRefreshedAt ? new Date(b.lastRefreshedAt).getTime() : 0;
        return tA - tB;
      });

      const orderedCandidates: AccountInfo[] = [
        ...(active && !active.isBanned && active.status !== 'banned' && active.status !== 'auth_failed' ? [active] : []),
        ...otherEligible
      ];

      // If not force (e.g. background startup), filter strictly to stale accounts (>= 30s)
      const accountsToRefresh = force
        ? orderedCandidates
        : orderedCandidates.filter((acc) => this.isAccountStale(acc));

      if (accountsToRefresh.length === 0) {
        console.log('[Antigravity Swap] All accounts are fresh (< 30s). Skipping global network refresh.');
        await this.ctx.reloadFromStorage();
        return;
      }

      this.isBackgroundRefreshing = true;
      this.ctx.notifyStateChange();

      const total = accountsToRefresh.length;
      let completedCount = 0;

      for (let i = 0; i < total; i += batchSize) {
        const chunk = accountsToRefresh.slice(i, i + batchSize);
        await Promise.all(
          chunk.map(async (acc) => {
            try {
              await this.refreshAccountQuota(acc.email, true, true);
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

        const merged = this.mergeWithDiskAccounts(this.ctx.getAccounts());
        this.ctx.setAccounts(merged);
        await this.storage.saveAccounts(merged);
        this.ctx.notifyStateChange();

        this.storage.renewRefreshLease();

        // Pacing delay between batch chunks to prevent API rate limits
        if (i + batchSize < total && pacingDelayMs > 0) {
          await new Promise((r) => setTimeout(r, pacingDelayMs));
        }
      }

      await this.ctx.checkAutoSwitch();
    } finally {
      this.isBackgroundRefreshing = false;
      this.storage.releaseRefreshLease();
      this.ctx.notifyStateChange();
    }
  }

  /**
   * Heartbeat execution: polls active account quota and checks background accounts in small batches.
   * Checks the distributed lease so multiple instances do not spam Google APIs simultaneously.
   */
  public async runHeartbeatTick(): Promise<void> {
    // Keep active state synchronized with IDE external login/logout
    await this.ctx.checkExternalIdeSession().catch(() => {});

    // Try to acquire distributed lease for background heartbeat polling
    if (!this.storage.tryAcquireRefreshLease(false)) {
      // Another instance recently refreshed or is in progress; reload shared data
      await this.ctx.reloadFromStorage();
      await this.ctx.checkAutoSwitch();
      return;
    }

    try {
      const active = this.ctx.getActiveAccount();
      const accounts = this.ctx.getAccounts();
      const eligibleAccounts = accounts.filter(
        (a) => !a.isBanned && a.status !== 'banned' && a.status !== 'auth_failed'
      );

      const accountsToRefresh: AccountInfo[] = [];

      // 1. ALWAYS prioritize active account first (if healthy and stale)
      if (active && !active.isBanned && active.status !== 'banned' && active.status !== 'auth_failed') {
        if (this.isAccountStale(active)) {
          accountsToRefresh.push(active);
        }
      }

      // 2. Select background accounts in batch (oldest lastRefreshedAt first, only if stale)
      const backgroundBatchSize = EXTENSION_DEFAULTS.BACKGROUND_REFRESH_BATCH_SIZE;
      const otherEligible = eligibleAccounts.filter(
        (a) => a.email.toLowerCase() !== active?.email.toLowerCase()
      );

      otherEligible.sort((a, b) => {
        const tA = a.lastRefreshedAt ? new Date(a.lastRefreshedAt).getTime() : 0;
        const tB = b.lastRefreshedAt ? new Date(b.lastRefreshedAt).getTime() : 0;
        return tA - tB;
      });

      const staleOtherEligible = otherEligible.filter((a) => this.isAccountStale(a));
      const backgroundChunk = staleOtherEligible.slice(0, backgroundBatchSize);
      accountsToRefresh.push(...backgroundChunk);

      // 3. Batch execute refresh concurrently if any accounts need it
      if (accountsToRefresh.length > 0) {
        this.isBackgroundRefreshing = true;
        this.ctx.notifyStateChange();

        await Promise.all(
          accountsToRefresh.map(async (target) => {
            try {
              await this.refreshAccountQuota(target.email, true, true);
            } catch (err) {
              console.warn(`[Antigravity Swap] Background refresh error for ${target.email}:`, err);
            }
          })
        );

        const merged = this.mergeWithDiskAccounts(this.ctx.getAccounts());
        this.ctx.setAccounts(merged);
        await this.storage.saveAccounts(merged);
        this.ctx.notifyStateChange();
      }

      await this.ctx.checkAutoSwitch();
    } finally {
      this.isBackgroundRefreshing = false;
      this.storage.releaseRefreshLease();
      this.ctx.notifyStateChange();
    }
  }
}
