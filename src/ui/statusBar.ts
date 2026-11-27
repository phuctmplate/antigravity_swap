import * as vscode from "vscode";
import { AccountService } from "../account";
import { SAFE_WEEKLY_THRESHOLDS } from "../constants";
import { IdeActiveQuotaResult } from "../quota";

export class StatusBarService implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private cachedIdeQuota: IdeActiveQuotaResult | null = null;
  private idePollTimer?: NodeJS.Timeout;
  private stateRefreshTimer?: NodeJS.Timeout;

  constructor(private readonly accountService: AccountService) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusBarItem.command = "antigravitySwap.openQuickMenu";
    this.disposables.push(this.statusBarItem);

    this.disposables.push(
      this.accountService.onDidChangeState(() => {
        this.update();
        if (this.stateRefreshTimer) {
          clearTimeout(this.stateRefreshTimer);
        }
        this.stateRefreshTimer = setTimeout(() => {
          this.refreshIdeQuota();
        }, 150);
      }),
    );

    this.update();
    this.statusBarItem.show();

    // Check shared IDE quota cache / refresh every 15s (single-flight leader enforces 25s/35s TTL across instances)
    this.refreshIdeQuota();
    this.idePollTimer = setInterval(() => {
      this.refreshIdeQuota();
    }, 15000);
    this.disposables.push({
      dispose: () => {
        if (this.idePollTimer) {
          clearInterval(this.idePollTimer);
        }
        if (this.stateRefreshTimer) {
          clearTimeout(this.stateRefreshTimer);
        }
      },
    });
  }

  private async refreshIdeQuota(): Promise<void> {
    try {
      const active = this.accountService.getActiveAccount();
      if (!active) {
        this.cachedIdeQuota = null;
        return;
      }
      if (this.cachedIdeQuota && this.cachedIdeQuota.email.toLowerCase() !== active.email.toLowerCase()) {
        this.cachedIdeQuota = null;
      }
      // Focused window refreshes every 25s; unfocused windows wait up to 35s so they naturally reuse focused cache
      const isFocused = vscode.window.state?.focused !== false;
      const cacheTtlMs = isFocused ? 25000 : 35000;
      const ideRes = await this.accountService.getActiveAccountIdeQuota(2500, {
        expectedEmail: active.email,
        cacheTtlMs,
        forceRefresh: false
      });
      if (ideRes && ideRes.email.toLowerCase() === active.email.toLowerCase()) {
        const changed =
          !this.cachedIdeQuota ||
          this.cachedIdeQuota.geminiInstantPercentage !== ideRes.geminiInstantPercentage ||
          this.cachedIdeQuota.claudeInstantPercentage !== ideRes.claudeInstantPercentage ||
          this.cachedIdeQuota.accountInstantPercentage !== ideRes.accountInstantPercentage ||
          this.cachedIdeQuota.overallQuotaPercentage !== ideRes.overallQuotaPercentage ||
          this.cachedIdeQuota.geminiGroup?.weekly?.percentage !== ideRes.geminiGroup?.weekly?.percentage ||
          this.cachedIdeQuota.geminiGroup?.fiveHour?.percentage !== ideRes.geminiGroup?.fiveHour?.percentage ||
          this.cachedIdeQuota.claudeGptGroup?.weekly?.percentage !== ideRes.claudeGptGroup?.weekly?.percentage ||
          this.cachedIdeQuota.claudeGptGroup?.fiveHour?.percentage !== ideRes.claudeGptGroup?.fiveHour?.percentage;
        this.cachedIdeQuota = ideRes;
        if (changed) {
          this.update();
        }
      }
    } catch {}
  }

  public update(): void {
    const accounts = this.accountService.getAccounts();
    const active = this.accountService.getActiveAccount();
    const overall = this.accountService.getOverallSummary();
    const instantPct = overall.instantPercentage ?? 0;
    const overallPct = overall.overallPercentage ?? 0;

    if (accounts.length === 0 || !active) {
      const ideEmail = this.accountService.getIdeSessionEmail()?.toLowerCase();
      const ideMatch = ideEmail ? accounts.find((a) => a.email.toLowerCase() === ideEmail) : undefined;
      this.statusBarItem.text = "$(account) AGY Swap";
      this.statusBarItem.tooltip = ideMatch
        ? `Antigravity Swap: Detected ${ideMatch.email} signed in on IDE. Click to switch & take control.`
        : "Antigravity Swap: No active account. Click to connect or switch.";
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    const displayName = active.name
      ? active.name.split(" ")[0]
      : active.email.split("@")[0];

    if (active.status === "auth_failed" || active.needsReauth) {
      this.statusBarItem.text = `$(warning) ${displayName}: Not Verified | Pool Instant: ${instantPct}%`;
      this.statusBarItem.tooltip = `Antigravity Swap: Session not verified for ${active.email}. Click to re-login or switch.`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
      return;
    }

    const activeRefreshedMs = active.lastRefreshedAt ? new Date(active.lastRefreshedAt).getTime() : 0;
    const ideFetchedMs = this.cachedIdeQuota?.fetchedAt ?? 0;
    const hasIdeQuota =
      Boolean(
        this.cachedIdeQuota &&
        this.cachedIdeQuota.email.toLowerCase() === active.email.toLowerCase() &&
        (ideFetchedMs === 0 || ideFetchedMs >= activeRefreshedMs)
      );

    const geminiPct = hasIdeQuota
      ? this.cachedIdeQuota!.geminiInstantPercentage
      : this.accountService.getAccountTargetQuota(active, "gemini");
    const claudePct = hasIdeQuota
      ? this.cachedIdeQuota!.claudeInstantPercentage
      : this.accountService.getAccountTargetQuota(active, "claude");
    const accountInstantPct = hasIdeQuota
      ? this.cachedIdeQuota!.accountInstantPercentage
      : this.accountService.getAccountTargetQuota(active, "instant");
    const activePct = hasIdeQuota
      ? this.cachedIdeQuota!.overallQuotaPercentage
      : (active.averageQuotaPercentage ?? 0);

    const autoSwitchTarget = this.accountService.getAutoSwitchTarget();
    let targetQuota: number;
    if (autoSwitchTarget === "gemini") {
      targetQuota = geminiPct;
    } else if (autoSwitchTarget === "claude") {
      targetQuota = claudePct;
    } else {
      targetQuota = accountInstantPct;
    }

    // Color indicator based on quota health
    let icon = "$(zap)";
    if (active.isBanned) {
      icon = "$(error)";
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground",
      );
    } else if (targetQuota < 20) {
      icon = "$(warning)";
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }

    this.statusBarItem.text = `${icon} ${displayName} (Gemini Instant: ${geminiPct}%, C&G Instant: ${claudePct}%) | Pool Instant: ${instantPct}%`;

    // Build a clean, readable MarkdownString tooltip
    const md = new vscode.MarkdownString("", true);
    md.isTrusted = true;
    md.supportThemeIcons = true;

    // Header
    md.appendMarkdown(`### $(zap) Antigravity Swap\n\n`);

    // All accounts pool summary line (at top)
    const allAccIcon = overallPct < 20 ? "$(warning)" : "$(account)";
    md.appendMarkdown(
      `${allAccIcon} **All ${overall.totalAccounts} account(s):** **All Accounts Instant Quota:** ${instantPct}% · **Total Quota:** ${overallPct}%\n\n`,
    );

    md.appendMarkdown(`---\n\n`);

    // Active account info
    const accountHealthIcon = active.isBanned
      ? "$(error)"
      : targetQuota < 20
        ? "$(warning)"
        : "$(check)";
    const emailCode = `\`${active.email}\``;
    const nameDisplay =
      active.name && active.name !== active.email
        ? `**${active.name}** (${emailCode})`
        : emailCode;
    md.appendMarkdown(`**Active:** ${nameDisplay} ${accountHealthIcon}\n\n`);

    // Model quotas section - concise and grouped by model family
    const isFree =
      !active.tierBadge ||
      active.tierBadge === "STANDARD FREE" ||
      active.accountType?.toLowerCase().includes("free") === true;
    const isPro =
      active.tierBadge === "PRO" || active.tierBadge === "AI PREMIUM";
    const isUltra =
      active.tierBadge === "ULTRA" || active.tierBadge === "ENTERPRISE";
    const quotas = active.quotas ?? [];
    const weeklyQuotas = quotas.filter(
      (q) => q.windowType === "weekly" && !q.disabled && q.percentage >= 0,
    );
    const fiveHourQuotas = quotas.filter(
      (q) => q.windowType === "5h" && !q.disabled && q.percentage >= 0,
    );

    const geminiGroup =
      (hasIdeQuota ? this.cachedIdeQuota!.geminiGroup : undefined) ||
      active.geminiGroup ||
      active.quotaGroups?.find(
        (g) =>
          g.id === "gemini" ||
          (g.name.toLowerCase().includes("gemini") &&
            !g.name.toLowerCase().includes("argon")),
      );
    const geminiWeekly =
      geminiGroup?.weekly ||
      weeklyQuotas.find(
        (q) =>
          (!isPro || !q.displayName.toLowerCase().includes("argon")) &&
          (q.displayName.toLowerCase().includes("gemini") ||
            q.displayName.toLowerCase().includes("pro")),
      );
    const gemini5h =
      geminiGroup?.fiveHour ||
      fiveHourQuotas.find(
        (q) =>
          (!isPro || !q.displayName.toLowerCase().includes("argon")) &&
          (q.displayName.toLowerCase().includes("gemini") ||
            q.displayName.toLowerCase().includes("flash")),
      );

    const argonGroup = isPro
      ? ((hasIdeQuota ? this.cachedIdeQuota!.argonGroup : undefined) ||
        active.argonGroup ||
        active.quotaGroups?.find(
          (g) => g.id === "argon" || g.name.toLowerCase().includes("argon"),
        ))
      : undefined;
    const argonWeekly = isPro
      ? argonGroup?.weekly ||
        weeklyQuotas.find((q) =>
          (q.id + " " + q.displayName + " " + (q.groupName || ""))
            .toLowerCase()
            .includes("argon"),
        )
      : undefined;

    const claudeGroup =
      (hasIdeQuota ? this.cachedIdeQuota!.claudeGptGroup : undefined) ||
      active.claudeGptGroup ||
      active.quotaGroups?.find(
        (g) =>
          g.id === "claude_gpt" ||
          g.name.toLowerCase().includes("claude") ||
          g.name.toLowerCase().includes("gpt"),
      );
    const claudeWeekly =
      claudeGroup?.weekly ||
      weeklyQuotas.find(
        (q) =>
          q.displayName.toLowerCase().includes("claude") ||
          q.displayName.toLowerCase().includes("gpt"),
      );
    const claude5h =
      claudeGroup?.fiveHour ||
      fiveHourQuotas.find(
        (q) =>
          q.displayName.toLowerCase().includes("claude") ||
          q.displayName.toLowerCase().includes("gpt"),
      );

    const formatBucket = (b?: {
      percentage: number;
      resetCountdown?: string;
      disabled?: boolean;
    }): string => {
      if (!b) return "N/A";
      if (b.disabled) return "Disabled";
      const pct =
        b.percentage === -1
          ? "Unlimited"
          : `${Math.max(0, Math.min(100, b.percentage))}%`;
      const reset = b.resetCountdown ? ` *(resets ${b.resetCountdown})*` : "";
      return `**${pct}**${reset}`;
    };
    if (geminiWeekly || gemini5h || claudeWeekly || claude5h || argonWeekly) {
      md.appendMarkdown(
        `**$(zap) Account Instant Quota:** **${accountInstantPct}%** (Gemini Instant Quota: **${geminiPct}%** · Claude & GPT Instant Quota: **${claudePct}%**)\n\n`,
      );
      md.appendMarkdown(
        `**$(dashboard) Account Total Quota:** **${activePct}%**\n\n`,
      );

      // If either model is attenuated by low weekly fuel, add a subtle note
      const isAttenuated =
        !isFree &&
        ((geminiWeekly &&
          geminiWeekly.percentage < SAFE_WEEKLY_THRESHOLDS.GEMINI &&
          gemini5h &&
          gemini5h.percentage > geminiPct) ||
          (claudeWeekly &&
            claudeWeekly.percentage < SAFE_WEEKLY_THRESHOLDS.CLAUDE_GPT &&
            claude5h &&
            claude5h.percentage > claudePct));
      if (isAttenuated) {
        md.appendMarkdown(
          `*$(warning) Account Instant Quota is currently modulated due to low remaining weekly fuel capacity.*\n\n`,
        );
      }

      md.appendMarkdown(`**$(pulse) Model Quotas**\n\n`);

      if (gemini5h || geminiWeekly) {
        const parts: string[] = [];
        if (!isFree && gemini5h) {
          parts.push(`5h: ${formatBucket(gemini5h)}`);
        }
        if (geminiWeekly) {
          parts.push(`Weekly: ${formatBucket(geminiWeekly)}`);
        }
        const gMin = Math.min(
          gemini5h?.percentage ?? 100,
          geminiWeekly?.percentage ?? 100,
        );
        const gIcon = gMin < 20 ? "$(warning)" : "$(check)";
        md.appendMarkdown(`* ${gIcon} **Gemini:** ${parts.join(" · ")}\n\n`);
      }

      if (isPro && argonWeekly && !argonWeekly.disabled && typeof argonWeekly.percentage === "number") {
        const aIcon = (argonWeekly.percentage ?? 100) < 20 ? "$(warning)" : "$(check)";
        md.appendMarkdown(
          `* ${aIcon} **Argon (Weekly Only):** Weekly: ${formatBucket(argonWeekly)}\n\n`,
        );
      }

      if (claude5h || claudeWeekly) {
        const parts: string[] = [];
        if (!isFree && claude5h) {
          parts.push(`5h: ${formatBucket(claude5h)}`);
        }
        if (claudeWeekly) {
          parts.push(`Weekly: ${formatBucket(claudeWeekly)}`);
        }
        const cMin = Math.min(
          claude5h?.percentage ?? 100,
          claudeWeekly?.percentage ?? 100,
        );
        const cIcon = cMin < 20 ? "$(warning)" : "$(check)";
        md.appendMarkdown(
          `* ${cIcon} **C&G (Claude & GPT):** ${parts.join(" · ")}\n\n`,
        );
      }
    } else if (quotas.length > 0) {
      md.appendMarkdown(
        `**$(zap) Account Instant Quota:** **${accountInstantPct}%** (Gemini Instant Quota: **${geminiPct}%** · Claude & GPT Instant Quota: **${claudePct}%**)\n\n`,
      );
      md.appendMarkdown(
        `**$(dashboard) Account Total Quota:** **${activePct}%**\n\n`,
      );
      md.appendMarkdown(`**$(pulse) Model Quotas**\n\n`);
      for (const q of quotas) {
        const isUnlimited = q.percentage === -1;
        const num = Math.max(0, Math.min(100, q.percentage || 0));
        const pct = isUnlimited ? "Unlimited" : `${num}%`;
        const healthIcon = isUnlimited
          ? "$(infinity)"
          : num > 50
            ? "$(check)"
            : num > 20
              ? "$(warning)"
              : "$(error)";
        const resetInfo = q.resetCountdown
          ? ` *(resets ${q.resetCountdown})*`
          : "";
        md.appendMarkdown(
          `* ${healthIcon} **${q.displayName}**: **${pct}**${resetInfo}\n\n`,
        );
      }
    } else if (!active.isBanned) {
      md.appendMarkdown(
        `$(info) No quota data yet. Open the panel and click **Refresh Quotas**.\n\n`,
      );
    }

    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`*$(list-unordered) Click to open the account switcher*`);

    this.statusBarItem.tooltip = md;
  }

  public async showQuickMenu(): Promise<void> {
    const accounts = this.accountService.getAccounts();
    const active = this.accountService.getActiveAccount();
    const overall = this.accountService.getOverallSummary();
    const instantPct = overall.instantPercentage ?? 0;
    const overallPct = overall.overallPercentage ?? 0;

    const items: vscode.QuickPickItem[] = [];

    const activeAccountInstantPct = active ? this.accountService.getAccountTargetQuota(active, "instant") : 0;
    items.push({
      label: `All Accounts Instant Quota: ${instantPct}% · Total Quota: ${overallPct}% across ${overall.totalAccounts} account(s)`,
      description: `Active: ${active ? active.email : "None"} (Account Instant Quota: ${activeAccountInstantPct}%, Total Quota: ${active ? active.averageQuotaPercentage : 0}%)`,
      kind: vscode.QuickPickItemKind.Separator,
    });

    const ideEmail = this.accountService.getIdeSessionEmail()?.toLowerCase();
    for (const acc of accounts) {
      const isAct = acc.email === active?.email && acc.isActive;
      const isIdeSession = !active && Boolean(ideEmail && acc.email.toLowerCase() === ideEmail);
      let statusIcon = isAct ? "$(check)" : "$(account)";
      let statusExtra = isIdeSession ? " [IN IDE]" : "";
      if (acc.isBanned) {
        statusIcon = "$(error)";
        statusExtra = " [BANNED]";
      } else if (acc.status === "auth_failed" || acc.needsReauth) {
        statusIcon = "$(warning)";
        statusExtra = " [NOT VERIFIED]";
      }

      const quotaPct = acc.averageQuotaPercentage ?? 0;
      const detailText = acc.isBanned
        ? "Account banned/disabled by Google TOS"
        : (acc.status === "auth_failed" || acc.needsReauth)
          ? "Session not verified or expired. Click to re-login."
          : isAct
            ? "CURRENTLY ACTIVE"
            : isIdeSession
              ? "Detected IDE session. Click to switch & take control."
              : "Click to switch without reloading";

      const accInstant = this.accountService.getAccountTargetQuota(acc, "instant");
      items.push({
        label: `${statusIcon} ${acc.name || acc.email}${statusExtra}`,
        description: `${acc.email} — Account Instant Quota: ${acc.isBanned ? "0%" : accInstant + "%"} · Total: ${acc.isBanned ? "0%" : quotaPct + "%"}`,
        detail: detailText,
        buttons: [
          ...(acc.isBanned || acc.status === "auth_failed" || acc.needsReauth
            ? [
                {
                  iconPath: new vscode.ThemeIcon("key"),
                  tooltip: "Re-login / Reconnect Account",
                },
              ]
            : [
                {
                  iconPath: new vscode.ThemeIcon("refresh"),
                  tooltip: "Refresh quota",
                },
              ]),
          {
            iconPath: new vscode.ThemeIcon("trash"),
            tooltip: "Remove account",
          },
        ],
      });
    }

    items.push({
      label: "Actions",
      kind: vscode.QuickPickItemKind.Separator,
    });

    items.push({
      label: "$(add) Add Account (Google OAuth)",
      description: "Sign in with a new Google Account via browser",
    });

    items.push({
      label: "$(key) Add Account (Manual Token)",
      description: "Paste Access / Refresh Token directly",
    });

    items.push({
      label: "$(refresh) Refresh All Quotas Now",
      description: "Force immediate background quota check",
    });

    const quickPick = vscode.window.createQuickPick();
    quickPick.title = "Antigravity Swap: Fast Account Switcher";
    quickPick.placeholder = "Select account to switch or choose an action";
    quickPick.items = items;

    quickPick.onDidTriggerItemButton(async (e) => {
      const targetEmail = e.item.description?.split(" — ")[0]?.trim();
      if (!targetEmail) return;

      const tooltip = (e.button as any).tooltip;
      if (tooltip === "Re-login / Reconnect Account") {
        quickPick.hide();
        await this.accountService.reloginAccount(targetEmail);
      } else if (tooltip === "Refresh quota") {
        await this.accountService.refreshAccountQuota(targetEmail);
      } else if (tooltip === "Remove account") {
        const confirm = await vscode.window.showWarningMessage(
          `Remove account ${targetEmail} from Antigravity Swap?`,
          { modal: true },
          "Remove",
        );
        if (confirm === "Remove") {
          await this.accountService.removeAccount(targetEmail);
          quickPick.items = quickPick.items.filter(
            (i) => !i.description?.startsWith(targetEmail),
          );
        }
      }
    });

    quickPick.onDidChangeSelection(async (selection) => {
      if (selection.length === 0) return;
      quickPick.hide();
      const chosen = selection[0];

      if (chosen.label.includes("Add Account (Google OAuth)")) {
        await this.accountService.addAccountViaOAuth();
      } else if (chosen.label.includes("Add Account (Manual Token)")) {
        await vscode.commands.executeCommand(
          "antigravitySwap.addAccountManual",
        );
      } else if (chosen.label.includes("Refresh All Quotas Now")) {
        await vscode.commands.executeCommand("antigravitySwap.refreshQuotas");
      } else {
        const email = chosen.description?.split(" — ")[0]?.trim();
        if (email) {
          await this.accountService.switchAccount(email, true);
        }
      }
    });

    quickPick.show();
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
