import { AccountInfo } from '../types';
import { StorageService } from '../storage';
import { IdeActiveQuotaResult, QuotaFetchResult, QuotaService } from '../quota';
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
   * Returns true if the passive IDE agy.exe snapshot differs from the currently stored active account quotas.
   */
  private hasIdeQuotaChanged(account: AccountInfo, ideRes: IdeActiveQuotaResult): boolean {
    const bucketSig = (b?: { remainingFraction?: number; percentage?: number; resetTime?: string }) =>
      b ? `${b.remainingFraction ?? ''}:${b.percentage ?? ''}:${b.resetTime ?? ''}` : 'none';

    const curGemini =
      account.geminiGroup ||
      account.quotaGroups?.find(
        (g) => g.id === 'gemini' || (g.name.toLowerCase().includes('gemini') && !g.name.toLowerCase().includes('argon'))
      );
    const curClaude =
      account.claudeGptGroup ||
      account.quotaGroups?.find(
        (g) => g.id === 'claude_gpt' || g.name.toLowerCase().includes('claude') || g.name.toLowerCase().includes('gpt')
      );
    const curArgon =
      account.argonGroup ||
      account.quotaGroups?.find((g) => g.id === 'argon' || g.name.toLowerCase().includes('argon'));

    return (
      bucketSig(curGemini?.fiveHour) !== bucketSig(ideRes.geminiGroup?.fiveHour) ||
      bucketSig(curGemini?.weekly) !== bucketSig(ideRes.geminiGroup?.weekly) ||
      bucketSig(curClaude?.fiveHour) !== bucketSig(ideRes.claudeGptGroup?.fiveHour) ||
      bucketSig(curClaude?.weekly) !== bucketSig(ideRes.claudeGptGroup?.weekly) ||
      bucketSig(curArgon?.weekly) !== bucketSig(ideRes.argonGroup?.weekly)
    );
  }

  private applyQuotaResultToAccount(
    account: AccountInfo,
    res: QuotaFetchResult,
    previousFiveHour: number | undefined,
    previousWeekly: number | undefined,
    wasActive: boolean
  ): AccountInfo {
    let externalActivity = account.externalActivityDetected ?? false;

    if (!wasActive) {
      const new5h = res.fiveHourPercentage;
      const newWk = res.weeklyPercentage;
      const dropped5h = previousFiveHour !== undefined && new5h !== undefined && new5h < previousFiveHour;
      const droppedWk = previousWeekly !== undefined && newWk !== undefined && newWk < previousWeekly;

      if (dropped5h || droppedWk) {
        externalActivity = true;
        console.log(
          `[AccountQuotaSync] External activity detected for ${account.email}: quota dropped on another machine (5h: ${previousFiveHour}% -> ${new5h}%, weekly: ${previousWeekly}% -> ${newWk}%).`
        );
      } else if ((new5h !== undefined && new5h > (previousFiveHour ?? 0)) || (newWk !== undefined && newWk > (previousWeekly ?? 0))) {
        externalActivity = false;
      }
    }

    const nowIso = new Date().toISOString();
    return {
      ...account,
      quotas: res.quotas,
      quotaGroups: res.quotaGroups,
      geminiGroup: res.geminiGroup,
      claudeGptGroup: res.claudeGptGroup,
      argonGroup: res.argonGroup,
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
      lastRefreshedAt: nowIso,
      lastHeartbeatAt: nowIso
    };
  }

  /**
   * Smart active quota monitor:
   * 1) Reads agy.exe RAM first (`forceRefresh = false`, ~6ms, 0 Google calls).
   *    If agy already refreshed on its own (e.g. while streaming), immediately shares the new quota with Sidebar & StatusBar
   *    and resets the freshness timer so no forced refresh is needed.
   * 2) Only if agy's values stayed unchanged AND >= ACTIVE_FORCE_REFRESH_THRESHOLD_MS (20s) elapsed,
   *    triggers a single shared `forceRefresh = true` refresh across windows.
   */
  public async syncActiveAccountFromIdeSmart(): Promise<void> {
    if (
      this.isBackgroundRefreshing ||
      typeof this.quotaService.fetchActiveAccountQuotaFromIde !== 'function' ||
      typeof this.quotaService.parseIdeQuotaResult !== 'function'
    ) {
      return;
    }

    const active = this.ctx.getActiveAccount();
    if (!active || active.isBanned || active.status === 'banned' || active.status === 'auth_failed') {
      return;
    }
    if (this.refreshingEmails.has(active.email)) {
      return;
    }

    const lastRefreshedMs = active.lastRefreshedAt ? new Date(active.lastRefreshedAt).getTime() : 0;
    const msSinceRefresh = isNaN(lastRefreshedMs) ? Infinity : Date.now() - lastRefreshedMs;

    try {
      const passiveIdeRes = await this.quotaService.fetchActiveAccountQuotaFromIde(1500, false, {
        expectedEmail: active.email,
        bypassSharedCache: true
      });

      if (
        passiveIdeRes &&
        passiveIdeRes.rawGroups &&
        passiveIdeRes.rawGroups.length > 0 &&
        passiveIdeRes.email.toLowerCase() === active.email.trim().toLowerCase() &&
        this.hasIdeQuotaChanged(active, passiveIdeRes)
      ) {
        const parsedRes = this.quotaService.parseIdeQuotaResult(passiveIdeRes, active);
        const latestAccounts = this.ctx.getAccounts();
        const curIdx = latestAccounts.findIndex((a) => a.email.toLowerCase() === active.email.toLowerCase());
        if (curIdx >= 0) {
          const updated = [...latestAccounts];
          updated[curIdx] = this.applyQuotaResultToAccount(
            updated[curIdx],
            parsedRes,
            updated[curIdx].fiveHourQuotaPercentage,
            updated[curIdx].weeklyQuotaPercentage,
            true
          );
          const merged = this.mergeWithDiskAccounts(updated);
          this.ctx.setAccounts(merged);
          await this.storage.saveAccounts(merged);
          this.ctx.notifyStateChange();
          await this.ctx.checkAutoSwitch();
        }
        return;
      }
    } catch {}

    // Passive snapshot matched stored state (or agy didn't respond): only forceRefresh=true once active threshold (20s) elapses.
    if (msSinceRefresh >= EXTENSION_DEFAULTS.ACTIVE_FORCE_REFRESH_THRESHOLD_MS) {
      await this.refreshAccountQuota(active.email, true, false, false);
      await this.ctx.checkAutoSwitch();
    }
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
  public async refreshAccountQuota(
    email: string,
    force = false,
    skipSave = false,
    bypassIdeCache = false
  ): Promise<void> {
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
    if (force && typeof (this.quotaService as any)?.invalidateCache === 'function') {
      (this.quotaService as any).invalidateCache(email);
    }

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
            needsReauth: true,
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

      if (tokens.hasRequiredScopes === false) {
        const latestAccounts = this.ctx.getAccounts();
        const curIdx = latestAccounts.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
        if (curIdx >= 0) {
          const updated = [...latestAccounts];
          updated[curIdx] = {
            ...updated[curIdx],
            status: 'auth_failed',
            needsReauth: true,
            missingScopes: tokens.missingScopes,
            hasRequiredScopes: false,
            statusMessage: 'Re-authorization required. Please sign in again.'
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

      const res = await this.quotaService.fetchAccountQuotas(
        acc,
        tokens,
        async (newTokens) => {
          await this.storage.saveAccountTokens(email, newTokens);

          const activeEmail = this.storage.getActiveAccountEmail()?.toLowerCase();
          if (acc.isActive || (activeEmail && email.toLowerCase() === activeEmail)) {
            console.log(`[AccountQuotaSync] Active account ${email} token refreshed during quota poll. Synchronizing keyring, USS and state.vscdb...`);
            try {
              // Pass triggerReconnect = false so background token refreshes for the active account do not reload the chat UI
              await this.storage.liveSwitchOAuthToken(acc, newTokens, false, false);
              await this.storage.syncToIdeStateDb(acc, newTokens);
            } catch (syncErr) {
              console.warn('[AccountQuotaSync] Failed to propagate refreshed token to IDE:', syncErr);
            }
          }
        },
        { bypassIdeCache: bypassIdeCache || (force && !skipSave) }
      );

      const latestAccounts = this.ctx.getAccounts();
      const curIdx = latestAccounts.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
      if (curIdx >= 0) {
        const updated = [...latestAccounts];
        updated[curIdx] = this.applyQuotaResultToAccount(
          updated[curIdx],
          res,
          previousFiveHour,
          previousWeekly,
          wasActive
        );
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
          argonGroup: ref.argonGroup,
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
              await this.refreshAccountQuota(acc.email, true, true, force);
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

    // Proactive Active Token Lifeline:
    // If the active account's token is expiring within 10 minutes (or already expired),
    // proactively refresh it and immediately synchronize to gemini:antigravity, in-memory USS, and state.vscdb!
    const activeAcc = this.ctx.getActiveAccount();
    if (activeAcc && !activeAcc.isBanned && activeAcc.status !== 'banned' && activeAcc.status !== 'auth_failed' && typeof this.storage.getAccountTokens === 'function') {
      try {
        const activeTokens = await this.storage.getAccountTokens(activeAcc.email);
        if (activeTokens && activeTokens.refreshToken) {
          const tenMinutesMs = 10 * 60 * 1000;
          const isExpiringSoon = !activeTokens.expiresAt || (Date.now() > activeTokens.expiresAt - tenMinutesMs);
          if (isExpiringSoon) {
            console.log(`[AccountQuotaSync] Active account ${activeAcc.email} token is near expiration (<10m). Refreshing proactively...`);
            const refreshed = await this.quotaService.refreshAccessToken(activeTokens.refreshToken);
            await this.storage.saveAccountTokens(activeAcc.email, refreshed);
            // Pass triggerReconnect = false so proactive token refresh runs 100% silently without reloading conversation
            await this.storage.liveSwitchOAuthToken(activeAcc, refreshed, false, false);
            await this.storage.syncToIdeStateDb(activeAcc, refreshed);
            console.log(`[AccountQuotaSync] Active account ${activeAcc.email} proactively refreshed and synchronized.`);
          }
        }
      } catch (proactiveErr: any) {
        console.warn(`[AccountQuotaSync] Proactive token refresh failed for ${activeAcc.email}:`, proactiveErr?.message || proactiveErr);
      }
    }

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

      // 1. ALWAYS prioritize active account first (if healthy and stale against active threshold 20s)
      if (active && !active.isBanned && active.status !== 'banned' && active.status !== 'auth_failed') {
        if (this.isAccountStale(active, EXTENSION_DEFAULTS.ACTIVE_FORCE_REFRESH_THRESHOLD_MS)) {
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
