import * as vscode from "vscode";
import { AccountManager } from "./accountManager";

export class StatusBarService implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly accountManager: AccountManager) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusBarItem.command = "antigravitySwap.openQuickMenu";
    this.disposables.push(this.statusBarItem);

    this.disposables.push(
      this.accountManager.onDidChangeState(() => this.update()),
    );

    this.update();
    this.statusBarItem.show();
  }

  public update(): void {
    const accounts = this.accountManager.getAccounts();
    const active = this.accountManager.getActiveAccount();
    const overall = this.accountManager.getOverallSummary();
    const instantPct = overall.instantPercentage ?? 0;
    const overallPct = overall.overallPercentage ?? 0;

    if (accounts.length === 0 || !active) {
      this.statusBarItem.text = "$(account) AGY Swap";
      this.statusBarItem.tooltip =
        "Antigravity Swap: No active account. Click to connect or switch.";
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    const displayName = active.name
      ? active.name.split(" ")[0]
      : active.email.split("@")[0];

    if (active.status === "auth_failed") {
      this.statusBarItem.text = `$(warning) ${displayName}: Auth Failed | Instant: ${instantPct}% | Overall: ${overallPct}%`;
      this.statusBarItem.tooltip = `Antigravity Swap: Authentication failed for ${active.email}. Click to re-login or switch.`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
      return;
    }

    const geminiPct = this.accountManager.getAccountTargetQuota(
      active,
      "gemini",
    );
    const claudePct = this.accountManager.getAccountTargetQuota(
      active,
      "claude",
    );
    const activePct = active.averageQuotaPercentage ?? 0;

    const minQuota = Math.min(geminiPct, claudePct);

    // Color indicator based on quota health
    let icon = "$(zap)";
    if (active.isBanned) {
      icon = "$(error)";
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground",
      );
    } else if (minQuota < 20 || activePct < 20) {
      icon = "$(warning)";
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }

    this.statusBarItem.text = `${icon} ${displayName} (Gemini: ${geminiPct}%, C&G: ${claudePct}%) | Instant: ${instantPct}% | Overall: ${overallPct}%`;

    // Build a clean, readable MarkdownString tooltip
    const md = new vscode.MarkdownString("", true);
    md.isTrusted = true;
    md.supportThemeIcons = true;

    // Header
    md.appendMarkdown(`### $(zap) Antigravity Swap\n\n`);

    // All accounts pool summary line (at top)
    const allAccIcon = overallPct < 20 ? "$(warning)" : "$(account)";
    md.appendMarkdown(
      `${allAccIcon} **All ${overall.totalAccounts} account(s):** **Instant:** ${instantPct}% · **Overall:** ${overallPct}%\n\n`,
    );
    md.appendMarkdown(
      `*$(info) 'Instant' calculates the true usable quota based on both the 5h (if available) and weekly limits.*\n\n`,
    );

    md.appendMarkdown(`---\n\n`);

    // Active account info
    const accountHealthIcon = active.isBanned
      ? "$(error)"
      : minQuota < 20
        ? "$(warning)"
        : "$(check)";
    const emailCode = `\`${active.email}\``;
    const nameDisplay =
      active.name && active.name !== active.email
        ? `**${active.name}** (${emailCode})`
        : emailCode;
    md.appendMarkdown(`**Active:** ${accountHealthIcon} ${nameDisplay}\n\n`);

    // Model quotas section - concise and grouped by model family
    const isFree =
      !active.tierBadge ||
      active.tierBadge === "STANDARD FREE" ||
      active.accountType?.toLowerCase().includes("free") === true;
    const quotas = active.quotas ?? [];
    const weeklyQuotas = quotas.filter(
      (q) => q.windowType === "weekly" && !q.disabled && q.percentage >= 0,
    );
    const fiveHourQuotas = quotas.filter(
      (q) => q.windowType === "5h" && !q.disabled && q.percentage >= 0,
    );

    const geminiGroup =
      active.geminiGroup ||
      active.quotaGroups?.find(
        (g) => g.id === "gemini" || g.name.toLowerCase().includes("gemini"),
      );
    const geminiWeekly =
      geminiGroup?.weekly ||
      weeklyQuotas.find(
        (q) =>
          q.displayName.toLowerCase().includes("gemini") ||
          q.displayName.toLowerCase().includes("pro"),
      );
    const gemini5h =
      geminiGroup?.fiveHour ||
      fiveHourQuotas.find(
        (q) =>
          q.displayName.toLowerCase().includes("gemini") ||
          q.displayName.toLowerCase().includes("flash"),
      );

    const claudeGroup =
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
    if (geminiWeekly || gemini5h || claudeWeekly || claude5h) {
      md.appendMarkdown(
        `**$(zap) Account Instant:** Gemini: **${geminiPct}%** · C&G: **${claudePct}%** *(Plan Total: ${activePct}%)*\n\n`,
      );

      // If either model is attenuated by low weekly fuel (< 40%), add a subtle note
      const isAttenuated =
        !isFree &&
        ((geminiWeekly &&
          geminiWeekly.percentage < 40 &&
          gemini5h &&
          gemini5h.percentage > geminiPct) ||
          (claudeWeekly &&
            claudeWeekly.percentage < 40 &&
            claude5h &&
            claude5h.percentage > claudePct));
      if (isAttenuated) {
        md.appendMarkdown(
          `*$(warning) Account instant capacity is currently modulated due to low remaining weekly fuel (< 40%).*\n\n`,
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
        `**$(zap) Account Instant:** Gemini: **${geminiPct}%** · C&G: **${claudePct}%** *(Plan Total: ${activePct}%)*\n\n`,
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
    const accounts = this.accountManager.getAccounts();
    const active = this.accountManager.getActiveAccount();
    const overall = this.accountManager.getOverallSummary();
    const instantPct = overall.instantPercentage ?? 0;
    const overallPct = overall.overallPercentage ?? 0;

    const items: vscode.QuickPickItem[] = [];

    items.push({
      label: `Instant: ${instantPct}% · Overall: ${overallPct}% across ${overall.totalAccounts} account(s)`,
      description: `Active: ${active ? active.email : "None"} (${active ? active.averageQuotaPercentage : 0}%)`,
      kind: vscode.QuickPickItemKind.Separator,
    });

    for (const acc of accounts) {
      const isAct = acc.email === active?.email && acc.isActive;
      let statusIcon = isAct ? "$(check)" : "$(account)";
      let statusExtra = "";
      if (acc.isBanned) {
        statusIcon = "$(error)";
        statusExtra = " [BANNED]";
      } else if (acc.status === "auth_failed") {
        statusIcon = "$(warning)";
        statusExtra = " [AUTH FAILED]";
      }

      const quotaPct = acc.averageQuotaPercentage ?? 0;
      const detailText = acc.isBanned
        ? "Account banned/disabled by Google TOS"
        : acc.status === "auth_failed"
          ? "Credentials expired. Click to re-login."
          : isAct
            ? "CURRENTLY ACTIVE"
            : "Click to switch without reloading";

      items.push({
        label: `${statusIcon} ${acc.name || acc.email}${statusExtra}`,
        description: `${acc.email} — ${acc.isBanned ? "0%" : quotaPct + "%"} quota left`,
        detail: detailText,
        buttons: [
          ...(acc.isBanned || acc.status === "auth_failed"
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
      label: "$(cloud-download) Import Current Antigravity Session",
      description: "Import the active logged-in account from Antigravity IDE",
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
        await this.accountManager.reloginAccount(targetEmail);
      } else if (tooltip === "Refresh quota") {
        await this.accountManager.refreshAccountQuota(targetEmail);
      } else if (tooltip === "Remove account") {
        const confirm = await vscode.window.showWarningMessage(
          `Remove account ${targetEmail} from Antigravity Swap?`,
          { modal: true },
          "Remove",
        );
        if (confirm === "Remove") {
          await this.accountManager.removeAccount(targetEmail);
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

      if (chosen.label.includes("Import Current Antigravity Session")) {
        await this.accountManager.importCurrentAntigravityAccount();
      } else if (chosen.label.includes("Add Account (Google OAuth)")) {
        await this.accountManager.addAccountViaOAuth();
      } else if (chosen.label.includes("Add Account (Manual Token)")) {
        await vscode.commands.executeCommand(
          "antigravitySwap.addAccountManual",
        );
      } else if (chosen.label.includes("Refresh All Quotas Now")) {
        await vscode.commands.executeCommand("antigravitySwap.refreshQuotas");
      } else {
        const email = chosen.description?.split(" — ")[0]?.trim();
        if (email) {
          await this.accountManager.switchAccount(email, true);
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
