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

    if (accounts.length === 0 || !active || active.status === 'auth_failed') {
      this.statusBarItem.text = '$(account) AGY Swap';
      this.statusBarItem.tooltip = 'Antigravity Swap: No active account. Click to connect or switch.';
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    const activePct = active.averageQuotaPercentage ?? 0;
    const overallPct = overall.overallPercentage ?? 0;

    // Color indicator based on quota health
    let icon = '$(zap)';
    if (active.isBanned) {
      icon = '$(error)';
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (activePct < 20) {
      icon = '$(warning)';
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }

    const displayName = active.name ? active.name.split(' ')[0] : active.email.split('@')[0];
    this.statusBarItem.text = `${icon} ${displayName}: ${activePct}% | All: ${overallPct}%`;

    // Detailed multi-line tooltip
    const lines = [
      `Antigravity Swap - Account & Quota Status`,
      `─────────────────────────────────────`,
      `Active: ${active.name || active.email} (${active.email})`,
      `Active Account Quota: ${activePct}%`,
      `Overall Across ${overall.totalAccounts} Account(s): ${overallPct}%`,
      ``,
      `--- Model Quotas (${active.email}) ---`
    ];

    if (active.quotas && active.quotas.length > 0) {
      for (const q of active.quotas.slice(0, 6)) {
        const bar = this.getProgressBar(q.percentage);
        lines.push(`• ${q.displayName}: ${bar} ${q.percentage}% ${q.resetCountdown ? '(' + q.resetCountdown + ')' : ''}`);
      }
    }

    lines.push(``, `Click to switch accounts or open dashboard`);
    this.statusBarItem.tooltip = new vscode.MarkdownString(lines.join('\n'));
  }

  private getProgressBar(pct: number): string {
    const filled = Math.round(pct / 20);
    const empty = 5 - filled;
    return '█'.repeat(filled) + '░'.repeat(Math.max(0, empty));
  }

  public async showQuickMenu(): Promise<void> {
    const accounts = this.accountManager.getAccounts();
    const active = this.accountManager.getActiveAccount();
    const overall = this.accountManager.getOverallSummary();

    const items: vscode.QuickPickItem[] = [];

    items.push({
      label: `Overall Quota: ${overall.overallPercentage}% across ${overall.totalAccounts} account(s)`,
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
          await this.accountManager.switchAccount(email);
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
