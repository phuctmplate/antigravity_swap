import * as vscode from 'vscode';
import { AccountManager } from './accountManager';

export class StatusBarService implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly accountManager: AccountManager) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'antigravitySwap.openQuickMenu';
    this.disposables.push(this.statusBarItem);

    this.disposables.push(
      this.accountManager.onDidChangeState(() => this.update())
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
      this.statusBarItem.text = '$(account) AGY Swap';
      this.statusBarItem.tooltip = 'Antigravity Swap: No active account. Click to connect or switch.';
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    const displayName = active.name ? active.name.split(' ')[0] : active.email.split('@')[0];

    if (active.status === 'auth_failed') {
      this.statusBarItem.text = `$(warning) ${displayName}: Auth Failed | Instant: ${instantPct}% | Overall: ${overallPct}%`;
      this.statusBarItem.tooltip = `Antigravity Swap: Authentication failed for ${active.email}. Click to re-login or switch.`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }

    const geminiPct = this.accountManager.getAccountTargetQuota(active, 'gemini');
    const claudePct = this.accountManager.getAccountTargetQuota(active, 'claude');
    const activePct = active.averageQuotaPercentage ?? 0;

    const minQuota = Math.min(geminiPct, claudePct);

    // Color indicator based on quota health
    let icon = '$(zap)';
    if (active.isBanned) {
      icon = '$(error)';
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (minQuota < 20 || activePct < 20) {
      icon = '$(warning)';
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }

    this.statusBarItem.text = `${icon} ${displayName} (Gemini: ${geminiPct}%, Claude: ${claudePct}%) | Instant: ${instantPct}% | Overall: ${overallPct}%`;

    // Build a clean, readable MarkdownString tooltip
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.supportThemeIcons = true;

    // Header
    md.appendMarkdown(`### $(zap) Antigravity Swap\n\n`);

    // Active account summary
    const accountHealthIcon = active.isBanned ? '$(error)' : minQuota < 20 ? '$(warning)' : '$(check)';
    md.appendMarkdown(`**Active:** ${active.name || active.email}\n\n`);
    md.appendMarkdown(`${accountHealthIcon} \`${active.email}\` — **Gemini: ${geminiPct}%** · **Claude & GPT: ${claudePct}%** (Total: ${activePct}%)\n\n`);

    // Overall & Instant summary line
    const allAccIcon = overallPct < 20 ? '$(warning)' : '$(account)';
    md.appendMarkdown(`${allAccIcon} **All ${overall.totalAccounts} account(s):** **Instant:** ${instantPct}% · **Overall:** ${overallPct}%\n\n`);

    // Model quotas section
    const quotas = active.quotas ?? [];
    if (quotas.length > 0) {
      md.appendMarkdown(`---\n\n`);
      md.appendMarkdown(`**$(pulse) Model Quotas**\n\n`);
      for (const q of quotas) {
        const isUnlimited = q.percentage === -1;
        const pct = isUnlimited ? 100 : Math.max(0, Math.min(100, q.percentage || 0));
        const healthIcon = isUnlimited ? '$(infinity)' : pct > 50 ? '$(check)' : pct > 20 ? '$(warning)' : '$(error)';
        const pctLabel = isUnlimited ? 'Unlimited' : `${pct}%`;
        const resetInfo = q.resetCountdown ? ` · resets ${q.resetCountdown}` : '';
        md.appendMarkdown(`${healthIcon} **${q.displayName}** — ${pctLabel}${resetInfo}\n\n`);
      }
    } else if (!active.isBanned) {
      md.appendMarkdown(`---\n\n`);
      md.appendMarkdown(`$(info) No quota data yet. Open the panel and click **Refresh Quotas**.\n\n`);
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
      description: `Active: ${active ? active.email : 'None'} (${active ? active.averageQuotaPercentage : 0}%)`,
      kind: vscode.QuickPickItemKind.Separator
    });

    for (const acc of accounts) {
      const isAct = acc.email === active?.email && acc.isActive;
      let statusIcon = isAct ? '$(check)' : '$(account)';
      let statusExtra = '';
      if (acc.isBanned) {
        statusIcon = '$(error)';
        statusExtra = ' [BANNED]';
      } else if (acc.status === 'auth_failed') {
        statusIcon = '$(warning)';
        statusExtra = ' [AUTH FAILED]';
      }

      const quotaPct = acc.averageQuotaPercentage ?? 0;
      const detailText = acc.isBanned
        ? 'Account banned/disabled by Google TOS'
        : acc.status === 'auth_failed'
        ? 'Credentials expired. Click to re-login.'
        : isAct
        ? 'CURRENTLY ACTIVE'
        : 'Click to switch without reloading';

      items.push({
        label: `${statusIcon} ${acc.name || acc.email}${statusExtra}`,
        description: `${acc.email} — ${acc.isBanned ? '0%' : quotaPct + '%'} quota left`,
        detail: detailText,
        buttons: [
          ...(acc.isBanned || acc.status === 'auth_failed'
            ? [
                {
                  iconPath: new vscode.ThemeIcon('key'),
                  tooltip: 'Re-login / Reconnect Account'
                }
              ]
            : [
                {
                  iconPath: new vscode.ThemeIcon('refresh'),
                  tooltip: 'Refresh quota'
                }
              ]),
          {
            iconPath: new vscode.ThemeIcon('trash'),
            tooltip: 'Remove account'
          }
        ]
      });
    }

    items.push({
      label: 'Actions',
      kind: vscode.QuickPickItemKind.Separator
    });

    items.push({
      label: '$(cloud-download) Import Current Antigravity Session',
      description: 'Import the active logged-in account from Antigravity IDE'
    });

    items.push({
      label: '$(add) Add Account (Google OAuth)',
      description: 'Sign in with a new Google Account via browser'
    });

    items.push({
      label: '$(key) Add Account (Manual Token)',
      description: 'Paste Access / Refresh Token directly'
    });

    items.push({
      label: '$(refresh) Refresh All Quotas Now',
      description: 'Force immediate background quota check'
    });

    const quickPick = vscode.window.createQuickPick();
    quickPick.title = 'Antigravity Swap: Fast Account Switcher';
    quickPick.placeholder = 'Select account to switch or choose an action';
    quickPick.items = items;

    quickPick.onDidTriggerItemButton(async (e) => {
      const targetEmail = e.item.description?.split(' — ')[0]?.trim();
      if (!targetEmail) return;

      const tooltip = (e.button as any).tooltip;
      if (tooltip === 'Re-login / Reconnect Account') {
        quickPick.hide();
        await this.accountManager.reloginAccount(targetEmail);
      } else if (tooltip === 'Refresh quota') {
        await this.accountManager.refreshAccountQuota(targetEmail);
      } else if (tooltip === 'Remove account') {
        const confirm = await vscode.window.showWarningMessage(
          `Remove account ${targetEmail} from Antigravity Swap?`,
          { modal: true },
          'Remove'
        );
        if (confirm === 'Remove') {
          await this.accountManager.removeAccount(targetEmail);
          quickPick.items = quickPick.items.filter((i) => !i.description?.startsWith(targetEmail));
        }
      }
    });

    quickPick.onDidChangeSelection(async (selection) => {
      if (selection.length === 0) return;
      quickPick.hide();
      const chosen = selection[0];

      if (chosen.label.includes('Import Current Antigravity Session')) {
        await this.accountManager.importCurrentAntigravityAccount();
      } else if (chosen.label.includes('Add Account (Google OAuth)')) {
        await this.accountManager.addAccountViaOAuth();
      } else if (chosen.label.includes('Add Account (Manual Token)')) {
        await vscode.commands.executeCommand('antigravitySwap.addAccountManual');
      } else if (chosen.label.includes('Refresh All Quotas Now')) {
        await vscode.commands.executeCommand('antigravitySwap.refreshQuotas');
      } else {
        const email = chosen.description?.split(' — ')[0]?.trim();
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
