import * as vscode from 'vscode';
import { AccountInfo, AutoSwitchTarget } from '../types';
import { StorageService } from '../storage';
import { calculateModulatedInstantQuota } from '../quota';
import { MODEL_WEIGHTS, SAFE_WEEKLY_THRESHOLDS } from '../constants';

export interface AccountAutoSwitcherContext {
  getAccounts: () => AccountInfo[];
  getActiveAccount: () => AccountInfo | undefined;
  switchAccount: (email: string) => Promise<boolean>;
  addAccountViaOAuth: () => Promise<AccountInfo | null>;
}

/**
 * AccountAutoSwitcher
 * Manages quota evaluation against auto-switch targets and automatically triggers
 * switching to healthy standby accounts when active quotas are depleted.
 */
export class AccountAutoSwitcher {
  private static readonly MAX_AUTO_SWITCH_ATTEMPTS = 2;
  private lastNotifiedDepletionKey?: string;

  constructor(
    private readonly storage: StorageService,
    private readonly ctx: AccountAutoSwitcherContext
  ) {}

  public resetDepletionKey(): void {
    this.lastNotifiedDepletionKey = undefined;
  }

  /**
   * Resolves the effective instant target quota for an account based on the selected target:
   * - 'instant' (or 'total'):
   *   - Free tier: weeklyQuotaPercentage (overall capacity).
   *   - Pro/Ultra: 5-Hour rolling window modulated by weekly capacity.
   * - 'gemini':
   *   - Free tier: Gemini group weekly quota only.
   *   - Pro/Ultra: Gemini 5-Hour rolling window modulated by Gemini weekly capacity.
   * - 'claude':
   *   - Free tier: Claude & GPT group weekly quota only.
   *   - Pro/Ultra: Claude 5-Hour rolling window modulated by Claude weekly capacity.
   */
  public getAccountTargetQuota(account: AccountInfo, target: AutoSwitchTarget = 'instant'): number {
    const isFree = !account.tierBadge || account.tierBadge === 'STANDARD FREE' || account.accountType?.toLowerCase().includes('free') === true;
    const quotas = account.quotas || [];
    const weeklyQuotas = quotas.filter((q) => q.windowType === 'weekly' && !q.disabled && q.percentage >= 0);
    // 5h quotas only relevant for paid tiers
    const fiveHourQuotas = isFree ? [] : quotas.filter((q) => q.windowType === '5h' && !q.disabled && q.percentage >= 0);

    if (target === 'instant') {
      const pWk = account.weeklyQuotaPercentage ?? account.averageQuotaPercentage ?? 0;
      if (isFree) {
        return pWk;
      }
      const geminiGroup = account.geminiGroup || account.quotaGroups?.find((g) => g.id === 'gemini' || g.name.toLowerCase().includes('gemini'));
      const gemini5h = geminiGroup?.fiveHour || fiveHourQuotas.find((q) => q.displayName.toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('flash'));
      const geminiWeekly = geminiGroup?.weekly || weeklyQuotas.find((q) => q.displayName.toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('pro'));
      const claudeGroup = account.claudeGptGroup || account.quotaGroups?.find((g) => g.id === 'claude_gpt' || g.name.toLowerCase().includes('claude') || g.name.toLowerCase().includes('gpt'));
      const claude5h = claudeGroup?.fiveHour || fiveHourQuotas.find((q) => q.displayName.toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('gpt'));
      const claudeWeekly = claudeGroup?.weekly || weeklyQuotas.find((q) => q.displayName.toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('gpt'));

      const validG5h = gemini5h && !gemini5h.disabled && gemini5h.percentage >= 0;
      const validGWk = geminiWeekly && !geminiWeekly.disabled && geminiWeekly.percentage >= 0;
      const validC5h = claude5h && !claude5h.disabled && claude5h.percentage >= 0;
      const validCWk = claudeWeekly && !claudeWeekly.disabled && claudeWeekly.percentage >= 0;

      let gInst: number | undefined;
      if (validG5h && validGWk) {
        gInst = calculateModulatedInstantQuota(gemini5h.percentage, geminiWeekly.percentage, SAFE_WEEKLY_THRESHOLDS.GEMINI);
      } else if (validG5h) {
        gInst = gemini5h.percentage;
      } else if (validGWk) {
        gInst = geminiWeekly.percentage;
      }

      let cInst: number | undefined;
      if (validC5h && validCWk) {
        cInst = calculateModulatedInstantQuota(claude5h.percentage, claudeWeekly.percentage, SAFE_WEEKLY_THRESHOLDS.CLAUDE_GPT);
      } else if (validC5h) {
        cInst = claude5h.percentage;
      } else if (validCWk) {
        cInst = claudeWeekly.percentage;
      }

      if (gInst !== undefined && cInst !== undefined) {
        return Math.round((gInst * MODEL_WEIGHTS.GEMINI) + (cInst * MODEL_WEIGHTS.CLAUDE));
      }
      if (gInst !== undefined) {
        return gInst;
      }
      if (cInst !== undefined) {
        return cInst;
      }

      const p5h = account.fiveHourQuotaPercentage;
      if (p5h !== undefined && pWk !== undefined) {
        return calculateModulatedInstantQuota(p5h, pWk, SAFE_WEEKLY_THRESHOLDS.DEFAULT);
      }
      return p5h ?? pWk;
    }

    if (target === 'gemini') {
      const geminiGroup = account.geminiGroup || account.quotaGroups?.find((g) => g.id === 'gemini' || g.name.toLowerCase().includes('gemini'));
      const geminiWeekly = geminiGroup?.weekly || weeklyQuotas.find((q) => q.displayName.toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('pro'));
      const gemini5h = geminiGroup?.fiveHour || fiveHourQuotas.find((q) => q.displayName.toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('flash'));

      if (!geminiGroup && !geminiWeekly && !gemini5h) {
        return 0;
      }

      if (isFree) {
        if (geminiWeekly && !geminiWeekly.disabled && geminiWeekly.percentage >= 0) {
          return geminiWeekly.percentage;
        }
        if (geminiGroup?.buckets?.[0]?.percentage !== undefined) {
          return geminiGroup.buckets[0].percentage;
        }
        return 0;
      } else {
        const p5h = (gemini5h && !gemini5h.disabled && gemini5h.percentage >= 0) ? gemini5h.percentage : undefined;
        const pWk = (geminiWeekly && !geminiWeekly.disabled && geminiWeekly.percentage >= 0) ? geminiWeekly.percentage : undefined;

        if (p5h !== undefined && pWk !== undefined) {
          return calculateModulatedInstantQuota(p5h, pWk, SAFE_WEEKLY_THRESHOLDS.GEMINI);
        }
        if (p5h !== undefined) return p5h;
        if (pWk !== undefined) return pWk;
        if (geminiGroup?.buckets?.[0]?.percentage !== undefined) {
          return geminiGroup.buckets[0].percentage;
        }
        return 0;
      }
    }

    if (target === 'claude') {
      const claudeGroup = account.claudeGptGroup || account.quotaGroups?.find((g) => g.id === 'claude_gpt' || g.name.toLowerCase().includes('claude') || g.name.toLowerCase().includes('gpt'));
      const claudeWeekly = claudeGroup?.weekly || weeklyQuotas.find((q) => q.displayName.toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('gpt'));
      const claude5h = claudeGroup?.fiveHour || fiveHourQuotas.find((q) => q.displayName.toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('gpt'));

      if (!claudeGroup && !claudeWeekly && !claude5h) {
        return 0;
      }

      if (isFree) {
        if (claudeWeekly && !claudeWeekly.disabled && claudeWeekly.percentage >= 0) {
          return claudeWeekly.percentage;
        }
        if (claudeGroup?.buckets?.[0]?.percentage !== undefined) {
          return claudeGroup.buckets[0].percentage;
        }
        return 0;
      } else {
        const p5h = (claude5h && !claude5h.disabled && claude5h.percentage >= 0) ? claude5h.percentage : undefined;
        const pWk = (claudeWeekly && !claudeWeekly.disabled && claudeWeekly.percentage >= 0) ? claudeWeekly.percentage : undefined;

        if (p5h !== undefined && pWk !== undefined) {
          return calculateModulatedInstantQuota(p5h, pWk, SAFE_WEEKLY_THRESHOLDS.CLAUDE_GPT);
        }
        if (p5h !== undefined) return p5h;
        if (pWk !== undefined) return pWk;
        if (claudeGroup?.buckets?.[0]?.percentage !== undefined) {
          return claudeGroup.buckets[0].percentage;
        }
        return 0;
      }
    }

    return account.averageQuotaPercentage ?? 0;
  }

  /**
   * Auto-switches to next account with healthy quota if current account is exhausted or unusable.
   * If autoSwitch is turned OFF, it NEVER auto-switches under any circumstance.
   */
  public async checkAutoSwitch(): Promise<void> {
    const autoSwitch = this.storage.getAutoSwitchEnabled();
    if (!autoSwitch) return;

    const active = this.ctx.getActiveAccount();
    if (!active) return;

    const isAuthFailed = active.status === 'auth_failed';
    const isBanned = active.isBanned || active.status === 'banned';

    // If account credentials are ok, wait until quota data is loaded before evaluating low quota
    if (!isAuthFailed && !isBanned) {
      if (!active.lastRefreshedAt || !active.quotas || active.quotas.length === 0) {
        return;
      }
    }

    const threshold = this.storage.getAutoSwitchThreshold();
    const target = this.storage.getAutoSwitchTarget();

    const activeQuota = this.getAccountTargetQuota(active, target);
    const isDepleted = activeQuota <= threshold;
    const isUnusable = isAuthFailed || isBanned;

    if (isDepleted || isUnusable) {
      const targetLabel = target === 'gemini' ? 'Gemini Instant' : target === 'claude' ? 'Claude & GPT Instant' : 'Account Instant';

      let reason: string;
      if (isAuthFailed) {
        reason = 'authentication failed (token expired/invalid)';
      } else if (isBanned) {
        reason = 'account suspended/banned by Google';
      } else {
        reason = `low ${targetLabel} (${activeQuota}%)`;
      }

      // Maximum candidate attempts per auto-switch cycle
      let attempts = 0;
      let switchSuccess = false;
      const failedCandidateEmails = new Set<string>();

      while (attempts < AccountAutoSwitcher.MAX_AUTO_SWITCH_ATTEMPTS) {
        const accounts = this.ctx.getAccounts();

        // Find candidates that have healthy quota for this target, excluding failed ones in this cycle
        const candidates = accounts.filter((a) => {
          if (a.email === active.email || a.isBanned || a.status === 'banned' || a.status === 'auth_failed' || failedCandidateEmails.has(a.email)) {
            return false;
          }
          if (a.status !== 'healthy' && a.status !== 'active') return false;
          return this.getAccountTargetQuota(a, target) > threshold;
        });

        // Best candidate: sort descending by that target's instant quota
        candidates.sort((a, b) => {
          return this.getAccountTargetQuota(b, target) - this.getAccountTargetQuota(a, target);
        });

        const candidate = candidates[0];
        if (!candidate) {
          // No more eligible candidates available
          break;
        }

        attempts++;
        const candidateQuota = this.getAccountTargetQuota(candidate, target);
        const candidateDetails = `${targetLabel}: ${candidateQuota}%`;

        // Extend distributed lease before attempting switch so other instances know we are active
        this.storage.renewRefreshLease?.();

        vscode.window.showWarningMessage(
          `Account ${active.email} has ${reason}. Auto-switching to ${candidate.email} (${candidateDetails} left)...`
        );

        switchSuccess = await this.ctx.switchAccount(candidate.email);

        // Immediately renew lease after switch attempt (whether succeeded or failed)
        this.storage.renewRefreshLease?.();

        if (switchSuccess) {
          this.lastNotifiedDepletionKey = undefined;
          return;
        }

        // Switch to this candidate failed: record and try next candidate if under limit
        failedCandidateEmails.add(candidate.email);
        console.warn(`[Antigravity Swap] Auto-switch attempt ${attempts} to ${candidate.email} failed.`);
      }

      // If we reach here, either no candidates existed or all attempts (up to 2) failed
      const accounts = this.ctx.getAccounts();
      if (!switchSuccess && accounts.length > 1) {
        const depletionKey = `${active.email}:${target}:${isAuthFailed ? 'auth' : isBanned ? 'banned' : 'depleted'}:${attempts}`;
        if (this.lastNotifiedDepletionKey !== depletionKey) {
          this.lastNotifiedDepletionKey = depletionKey;
          const msg = attempts > 0
            ? `[Antigravity Swap] Auto-Switch: Failed to switch after ${attempts} candidate attempt(s). Staying on current account.`
            : `[Antigravity Swap] Auto-Switch: No healthy standby accounts available for ${targetLabel}.`;

          vscode.window.showErrorMessage(msg, 'Add Account', 'Open Dashboard').then(async (selection) => {
            if (selection === 'Add Account') {
              await this.ctx.addAccountViaOAuth();
            } else if (selection === 'Open Dashboard') {
              await vscode.commands.executeCommand('antigravitySwap.openDashboard');
            }
          });
        }
      }
    } else {
      // Account is healthy and within quota limits: reset depletion notification key
      this.lastNotifiedDepletionKey = undefined;
    }
  }
}
