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
    const active = this.accountManager.getActiveAccount();
    const overall = this.accountManager.getOverallSummary();

    if (!active) {
      this.statusBarItem.text = '$(account) Antigravity Swap: No Account';
      this.statusBarItem.tooltip = 'Click to connect Google/Antigravity account';
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    const activePct = active.averageQuotaPercentage ?? 0;
    const overallPct = overall.overallPercentage ?? 0;

    // Color indicator based on quota health
    let icon = '$(zap)';
    if (activePct < 20) {
      icon = '$(warning)';
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }

    const displayName = active.name ? active.name.split(' ')[0] : active.email.split('@')[0];
    this.statusBarItem.text = `${icon} ${displayName}: ${activePct}% | All: ${overallPct}%`;

    // Detailed multi-line tooltip
    const lines = [
      `⚡ Antigravity Swap - Account & Quota Status`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `👤 Active: ${active.name || active.email} (${active.email})`,
      `📊 Active Account Quota: ${activePct}%`,
      `🌐 Overall Across ${overall.totalAccounts} Account(s): ${overallPct}%`,
      ``,
      `--- Model Quotas (${active.email}) ---`
    ];

    if (active.quotas && active.quotas.length > 0) {
      for (const q of active.quotas.slice(0, 6)) {
        const bar = this.getProgressBar(q.percentage);
        lines.push(`• ${q.displayName}: ${bar} ${q.percentage}% ${q.resetCountdown ? '(' + q.resetCountdown + ')' : ''}`);
      }
    }

    lines.push(``, `👉 Click to switch accounts or view detailed dashboard`);
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
      label: `🌐 Overall Quota: ${overall.overallPercentage}% across ${overall.totalAccounts} account(s)`,
      description: `Active: ${active ? active.email : 'None'} (${active ? active.averageQuotaPercentage : 0}%)`,
      kind: vscode.QuickPickItemKind.Separator
    });

    for (const acc of accounts) {
      const isAct = acc.email === active?.email;
      const statusIcon = isAct ? '$(check)' : '$(account)';
      const quotaPct = acc.averageQuotaPercentage ?? 0;
      items.push({
        label: `${statusIcon} ${acc.name || acc.email}`,
        description: `${acc.email} — ${quotaPct}% quota left`,
        detail: isAct ? '★ CURRENTLY ACTIVE' : 'Click to switch without reloading',
        buttons: [
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
      label: '$(add) Add Account (Google OAuth)',
      description: 'Sign in with Google via Browser'
    });

    items.push({
      label: '$(key) Add Account Manually',
      description: 'Paste Access Token / Refresh Token'
    });

    items.push({
      label: '$(refresh) Refresh All Quotas',
      description: 'Fetch real-time quota balances now'
    });

    items.push({
      label: '$(dashboard) Open Quota Dashboard Panel',
      description: 'View full charts and model breakdown'
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select an account to switch or an action'
    });

    if (!selected) return;

    if (selected.label.includes('Add Account (Google OAuth)')) {
      await vscode.commands.executeCommand('antigravitySwap.addAccount');
    } else if (selected.label.includes('Add Account Manually')) {
      await vscode.commands.executeCommand('antigravitySwap.addAccountManual');
    } else if (selected.label.includes('Refresh All Quotas')) {
      await vscode.commands.executeCommand('antigravitySwap.refreshQuotas');
    } else if (selected.label.includes('Open Quota Dashboard Panel')) {
      await vscode.commands.executeCommand('antigravitySwap.openDashboard');
    } else {
      // Find matching account by email in description
      const matched = accounts.find((a) => selected.description?.includes(a.email) || selected.label.includes(a.email));
      if (matched) {
        await this.accountManager.switchAccount(matched.email);
      }
    }
  }

  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
