import * as vscode from 'vscode';
import { AccountInfo, AutoSwitchTarget } from '../types';
import { StorageService } from '../storage';
import { calculateModulatedInstantQuota, getAccountTierWeight, JitProbeResult, IdeActiveQuotaResult } from '../quota';
import { MODEL_WEIGHTS, SAFE_WEEKLY_THRESHOLDS, EXTENSION_DEFAULTS } from '../constants';

export interface AccountAutoSwitcherContext {
  getAccounts: () => AccountInfo[];
  getActiveAccount: () => AccountInfo | undefined;
  switchAccount: (email: string, isManual?: boolean, isSilent?: boolean) => Promise<boolean>;
  addAccountViaOAuth: () => Promise<AccountInfo | null>;
  probeCandidate?: (email: string) => Promise<JitProbeResult>;
  onCandidateDepletedExternally?: (email: string, probeResult: JitProbeResult) => Promise<void>;
  onCandidateProbed?: (email: string, probeResult: JitProbeResult) => Promise<void>;
  getIdeActiveQuota?: () => Promise<IdeActiveQuotaResult | null>;
}

/**
 * AccountAutoSwitcher
 * Manages quota evaluation against auto-switch targets and automatically triggers
 * switching to healthy standby accounts when active quotas are depleted.
 */
export class AccountAutoSwitcher {
  private static readonly MAX_AUTO_SWITCH_ATTEMPTS = 2;
  private lastNotifiedDepletionKey?: string;
  private temporarilyFailedCandidates = new Map<string, number>();
  private cyclePausedUntil = 0;
  private awaitingRecoverySwitch = false;
  private _isAutoSwitchInProgress = false;

  constructor(
    private readonly storage: StorageService,
    private readonly ctx: AccountAutoSwitcherContext
  ) {}

  public isAutoSwitchInProgress(): boolean {
    return this._isAutoSwitchInProgress;
  }

  public isAwaitingRecovery(): boolean {
    return this.awaitingRecoverySwitch;
  }

  public setAwaitingRecovery(value: boolean): void {
    this.awaitingRecoverySwitch = value;
  }

  public clearFailedCandidate(email: string): void {
    this.temporarilyFailedCandidates.delete(email.toLowerCase());
    this.cyclePausedUntil = 0;
  }

  public resetDepletionKey(): void {
    this.lastNotifiedDepletionKey = undefined;
    this.cyclePausedUntil = 0;
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
    // Weekly quotas strictly exclude Argon (Argon is not counted towards target/average quotas)
    const weeklyQuotas = quotas.filter((q) =>
      q.windowType === 'weekly' &&
      !q.disabled &&
      q.percentage >= 0 &&
      !((q.id || '') + ' ' + (q.displayName || '') + ' ' + (q.groupName || '')).toLowerCase().includes('argon')
    );
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
   * Resolves the weekly reserve percentage for the requested target, excluding Argon.
   */
  public getAccountTargetWeeklyQuota(account: AccountInfo, target: AutoSwitchTarget = 'instant'): number {
    const quotas = account.quotas || [];
    const weeklyQuotas = quotas.filter((q) =>
      q.windowType === 'weekly' &&
      !q.disabled &&
      q.percentage >= 0 &&
      !((q.id || '') + ' ' + (q.displayName || '') + ' ' + (q.groupName || '')).toLowerCase().includes('argon')
    );

    const geminiGroup = account.geminiGroup || account.quotaGroups?.find((g) => g.id === 'gemini' || g.name.toLowerCase().includes('gemini'));
    const geminiWeekly = geminiGroup?.weekly || weeklyQuotas.find((q) => q.displayName.toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('pro'));
    const claudeGroup = account.claudeGptGroup || account.quotaGroups?.find((g) => g.id === 'claude_gpt' || g.name.toLowerCase().includes('claude') || g.name.toLowerCase().includes('gpt'));
    const claudeWeekly = claudeGroup?.weekly || weeklyQuotas.find((q) => q.displayName.toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('gpt'));

    const validGWk = geminiWeekly && !geminiWeekly.disabled && geminiWeekly.percentage >= 0 ? geminiWeekly.percentage : undefined;
    const validCWk = claudeWeekly && !claudeWeekly.disabled && claudeWeekly.percentage >= 0 ? claudeWeekly.percentage : undefined;

    if (target === 'gemini') {
      return validGWk ?? geminiGroup?.buckets?.[0]?.percentage ?? 0;
    }
    if (target === 'claude') {
      return validCWk ?? claudeGroup?.buckets?.[0]?.percentage ?? 0;
    }

    if (account.weeklyQuotaPercentage !== undefined) {
      return account.weeklyQuotaPercentage;
    }
    if (validGWk !== undefined && validCWk !== undefined) {
      return Math.round(validGWk * MODEL_WEIGHTS.GEMINI + validCWk * MODEL_WEIGHTS.CLAUDE);
    }
    return validGWk ?? validCWk ?? account.averageQuotaPercentage ?? 0;
  }

  /**
   * Computes capacity-weighted candidate score combining target instant quota and subscription tier pool size.
   * Because paid plans (Pro/AI Premium/Ultra/Enterprise) carry much larger absolute quota pools than Free,
   * a paid account at e.g. 25% instant scores significantly higher than a Free account at 100% instant.
   */
  public getCandidateSelectionScore(account: AccountInfo, target: AutoSwitchTarget = 'instant'): number {
    const targetQuota = this.getAccountTargetQuota(account, target);
    const tierWeight = getAccountTierWeight(account);
    return Math.round(targetQuota * tierWeight * 100) / 100;
  }

  /**
   * Deterministic candidate comparator (descending order: returns < 0 when `a` ranks higher than `b`).
   * 1. Capacity-weighted target instant quota (targetQuota * tierWeight)
   * 2. Capacity-weighted weekly reserve quota (weeklyQuota * tierWeight)
   * 3. Higher subscription tier weight
   * 4. More recent quota refresh timestamp
   */
  public compareCandidates(a: AccountInfo, b: AccountInfo, target: AutoSwitchTarget = 'instant'): number {
    const scoreDiff = this.getCandidateSelectionScore(b, target) - this.getCandidateSelectionScore(a, target);
    if (Math.abs(scoreDiff) > 0.001) {
      return scoreDiff;
    }

    const weightA = getAccountTierWeight(a);
    const weightB = getAccountTierWeight(b);
    const weeklyDiff =
      this.getAccountTargetWeeklyQuota(b, target) * weightB -
      this.getAccountTargetWeeklyQuota(a, target) * weightA;
    if (Math.abs(weeklyDiff) > 0.001) {
      return weeklyDiff;
    }

    if (weightB !== weightA) {
      return weightB - weightA;
    }

    const timeA = a.lastRefreshedAt ? Date.parse(a.lastRefreshedAt) || 0 : 0;
    const timeB = b.lastRefreshedAt ? Date.parse(b.lastRefreshedAt) || 0 : 0;
    return timeB - timeA;
  }

  /**
   * Auto-switches to next account with healthy quota if current account is exhausted or unusable.
   * If autoSwitch is turned OFF, it NEVER auto-switches under any circumstance.
   */
  public async checkAutoSwitch(): Promise<void> {
    const autoSwitch = this.storage.getAutoSwitchEnabled();
    if (!autoSwitch) return;

    if (this.cyclePausedUntil > Date.now()) {
      return;
    }

    this._isAutoSwitchInProgress = true;
    try {
      const active = this.ctx.getActiveAccount();
      if (!active && !this.awaitingRecoverySwitch) {
        return;
      }

      const isAuthFailed = active ? (active.status === 'auth_failed' || Boolean(active.needsReauth)) : false;
      const isBanned = active ? (active.isBanned || active.status === 'banned') : false;

      // If account credentials are ok, wait until quota data is loaded before evaluating low quota
      if (active && !isAuthFailed && !isBanned) {
        if (!active.lastRefreshedAt || !active.quotas || active.quotas.length === 0) {
          return;
        }
      }

      const threshold = this.storage.getAutoSwitchThreshold();
      const target = this.storage.getAutoSwitchTarget();

      const activeQuota = active ? this.getAccountTargetQuota(active, target) : 0;
      const isDepleted = active ? activeQuota <= threshold : false;
      const isUnusable = !active ? this.awaitingRecoverySwitch : (isAuthFailed || isBanned);

      if (isDepleted || isUnusable) {
        // SECONDARY GUARD: If trigger is quota depletion (not auth failure or ban),
        // check ngầm quota remain of active account in IDE as a 2nd protection layer
        // to prevent premature switches caused by stale or delayed Google API responses.
        if (active && isDepleted && !isUnusable && this.ctx.getIdeActiveQuota) {
          try {
            const ideQuota = await this.ctx.getIdeActiveQuota();
            if (ideQuota && ideQuota.email.toLowerCase() === active.email.toLowerCase()) {
              let ideTargetQuota = ideQuota.accountInstantPercentage;
              if (target === 'gemini') {
                ideTargetQuota = ideQuota.geminiInstantPercentage;
              } else if (target === 'claude') {
                ideTargetQuota = ideQuota.claudeInstantPercentage;
              }

              if (ideTargetQuota > threshold) {
                console.log(
                  `[AccountAutoSwitcher] Secondary IDE Quota Guard: API reported ${active.email} has low quota (${activeQuota}% <= ${threshold}%), but IDE Language Server reports healthy quota (${ideTargetQuota}%). Aborting premature switch.`
                );
                return;
              } else {
                console.log(
                  `[AccountAutoSwitcher] Secondary IDE Quota Guard: Confirmed low quota in IDE for ${active.email} (${ideTargetQuota}% <= ${threshold}%). Proceeding with auto-switch.`
                );
              }
            }
          } catch (guardErr) {
            console.warn('[AccountAutoSwitcher] Secondary IDE Quota Guard check failed; falling back to API decision:', guardErr);
          }
        }

        const targetLabel = target === 'gemini' ? 'Gemini Instant' : target === 'claude' ? 'Claude & GPT Instant' : 'Account Instant';

        let reason: string;
        if (!active) {
          reason = 'previous candidate switch rejection (awaiting recovery)';
        } else if (isAuthFailed) {
          reason = 'session not verified or expired';
        } else if (isBanned) {
          reason = 'account suspended/banned by Google';
        } else {
          reason = `low ${targetLabel} (${activeQuota}%)`;
        }

        // Maximum candidate attempts per auto-switch cycle
        let attempts = 0;
        let probeAttempts = 0;
        let switchSuccess = false;
        const failedCandidateEmails = new Set<string>();
        const probedCandidateEmails = new Set<string>();

        while (attempts < AccountAutoSwitcher.MAX_AUTO_SWITCH_ATTEMPTS && probeAttempts < 10) {
          const accounts = this.ctx.getAccounts();
          const currentActive = this.ctx.getActiveAccount();
          const activeEmailLower = (currentActive?.email || active?.email || '').toLowerCase();

          // Find candidates that have healthy quota for this target, excluding failed ones in this cycle and quarantined ones
          const candidates = accounts.filter((a) => {
            const emailLower = a.email.toLowerCase();
            if (
              (activeEmailLower && emailLower === activeEmailLower) ||
              a.isBanned ||
              a.status === 'banned' ||
              a.status === 'auth_failed' ||
              a.needsReauth ||
              failedCandidateEmails.has(emailLower)
            ) {
              return false;
            }
            const failedAt = this.temporarilyFailedCandidates.get(emailLower);
            if (failedAt && Date.now() - failedAt < EXTENSION_DEFAULTS.CANDIDATE_FAILURE_COOLDOWN_MS) {
              return false;
            }
            if (a.status !== 'healthy' && a.status !== 'active') return false;
            return this.getAccountTargetQuota(a, target) > threshold;
          });

          // Best candidate: sort descending by capacity-weighted quota score (paid pool capacity > free pool)
          candidates.sort((a, b) => this.compareCandidates(a, b, target));

          const candidate = candidates[0];
          if (!candidate) {
            // No more eligible candidates available
            break;
          }

          // JIT Pre-Switch Verification Guard (Layer 4):
          // Probe candidate in real-time (~150ms) to ensure quota wasn't burned on another machine
          if (EXTENSION_DEFAULTS.ENABLE_JIT_PRE_SWITCH_CHECK && this.ctx.probeCandidate && !probedCandidateEmails.has(candidate.email)) {
            probeAttempts++;
            probedCandidateEmails.add(candidate.email);
            try {
              const probeResult = await this.ctx.probeCandidate(candidate.email);
              if (probeResult && probeResult.ok) {
                // Always update candidate's live probed numbers in memory and storage
                if (this.ctx.onCandidateProbed) {
                  await this.ctx.onCandidateProbed(candidate.email, probeResult);
                }

                // 1. If completely depleted, mark as failed candidate in this cycle and bypass
                if (probeResult.isDepleted) {
                  console.warn(
                    `[AccountAutoSwitcher] JIT Guard detected ${candidate.email} is depleted externally (5h: ${probeResult.fiveHourPercentage}%, weekly: ${probeResult.weeklyPercentage}%). Bypassing candidate.`
                  );
                  failedCandidateEmails.add(candidate.email.toLowerCase());
                  if (this.ctx.onCandidateDepletedExternally) {
                    await this.ctx.onCandidateDepletedExternally(candidate.email, probeResult);
                  }
                  continue; // Try Candidate #2
                }

                // 2. Dynamic Demotion: Compare via capacity-weighted comparator so a paid account isn't demoted below a higher-% Free account.
                const currentAccounts = this.ctx.getAccounts();
                const refreshedCandidate = currentAccounts.find((a) => a.email === candidate.email) || candidate;
                const probedQuota = this.getAccountTargetQuota(refreshedCandidate, target);
                const probedScore = this.getCandidateSelectionScore(refreshedCandidate, target);

                const higherCandidate = candidates.slice(1).find((other) => {
                  const otherAcc = currentAccounts.find((a) => a.email === other.email) || other;
                  return this.compareCandidates(otherAcc, refreshedCandidate, target) < 0;
                });

                if (higherCandidate) {
                  const higherQuota = this.getAccountTargetQuota(higherCandidate, target);
                  const higherScore = this.getCandidateSelectionScore(higherCandidate, target);
                  console.log(
                    `[AccountAutoSwitcher] Candidate ${candidate.email} capacity dropped to ${probedQuota}% (score ${probedScore} < ${higherCandidate.email} ${higherQuota}% / score ${higherScore}). Demoting candidate rank immediately.`
                  );
                  // Continue without adding to failedCandidateEmails, so next while-iteration re-sorts and picks higherCandidate!
                  continue;
                }
              }
            } catch (jitErr) {
              console.warn(`[AccountAutoSwitcher] JIT probe failed for ${candidate.email}:`, jitErr);
            }
          }

          attempts++;
          const candidateQuota = this.getAccountTargetQuota(candidate, target);
          const candidateDetails = `${targetLabel}: ${candidateQuota}%`;
          const sourceLabel = active ? `Account ${active.email}` : 'Active IDE session';

          // Extend distributed lease before attempting switch so other instances know we are active
          this.storage.renewRefreshLease?.();

          vscode.window.showWarningMessage(
            `${sourceLabel} has ${reason}. Auto-switching to ${candidate.email} (${candidateDetails} left)...`
          );

          switchSuccess = await this.ctx.switchAccount(candidate.email, false, true);

          // Immediately renew lease after switch attempt (whether succeeded or failed)
          this.storage.renewRefreshLease?.();

          if (switchSuccess) {
            this.lastNotifiedDepletionKey = undefined;
            this.cyclePausedUntil = 0;
            this.awaitingRecoverySwitch = false;
            this.temporarilyFailedCandidates.delete(candidate.email.toLowerCase());
            return;
          }

          // Switch to this candidate failed: record in temporary failure cooldown and try next candidate if under limit
          this.temporarilyFailedCandidates.set(candidate.email.toLowerCase(), Date.now());
          failedCandidateEmails.add(candidate.email.toLowerCase());
          console.warn(`[Antigravity Swap] Auto-switch attempt ${attempts} to ${candidate.email} failed. Quarantined for ${EXTENSION_DEFAULTS.CANDIDATE_FAILURE_COOLDOWN_MS / 1000}s.`);
        }

        // If we reach here, either no candidates existed or all attempts (up to 2) failed
        if (!switchSuccess && attempts >= AccountAutoSwitcher.MAX_AUTO_SWITCH_ATTEMPTS) {
          this.cyclePausedUntil = Date.now() + EXTENSION_DEFAULTS.CANDIDATE_FAILURE_COOLDOWN_MS;
        }
        if (!switchSuccess && !this.ctx.getActiveAccount()) {
          this.awaitingRecoverySwitch = true;
        }

        const accounts = this.ctx.getAccounts();
        if (!switchSuccess && accounts.length > 1) {
          const depletionKey = `${active?.email || 'none'}:${target}:${isAuthFailed ? 'auth' : isBanned ? 'banned' : 'depleted'}:${attempts}`;
          if (this.lastNotifiedDepletionKey !== depletionKey) {
            this.lastNotifiedDepletionKey = depletionKey;
            const msg = attempts > 0
              ? `[Antigravity Swap] Auto-Switch: Stopped after ${attempts} failed candidate attempt(s).`
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
        // Account is healthy and within quota limits: reset depletion & recovery state
        this.lastNotifiedDepletionKey = undefined;
        this.cyclePausedUntil = 0;
        this.awaitingRecoverySwitch = false;
      }
    } finally {
      this._isAutoSwitchInProgress = false;
    }
  }
}
