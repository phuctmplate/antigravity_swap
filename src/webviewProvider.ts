import * as vscode from 'vscode';
import { AccountManager } from './accountManager';
import { AccountInfo, OverallQuotaSummary, ModelQuota } from './types';

export class WebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'antigravitySwap.dashboardView';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly accountManager: AccountManager
  ) {
    this.accountManager.onDidChangeState(() => this.updateWebview());
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.command) {
        case 'switchAccount':
          await this.accountManager.switchAccount(data.email);
          break;
        case 'refreshAll':
          await vscode.commands.executeCommand('antigravitySwap.refreshQuotas');
          break;
        case 'refreshAccount':
          await this.accountManager.refreshAccountQuota(data.email);
          break;
        case 'addOAuth':
          await vscode.commands.executeCommand('antigravitySwap.addAccount');
          break;
        case 'addManual':
          await vscode.commands.executeCommand('antigravitySwap.addAccountManual');
          break;
        case 'removeAccount':
          const confirm = await vscode.window.showWarningMessage(
            `Remove account ${data.email} from Antigravity Swap?`,
            { modal: true },
            'Remove'
          );
          if (confirm === 'Remove') {
            await this.accountManager.removeAccount(data.email);
          }
          break;
        case 'toggleAutoSwitch':
          // Toggle setting
          break;
        case 'ready':
          this.updateWebview();
          break;
      }
    });

    this.updateWebview();
  }

  public updateWebview(): void {
    if (!this._view) return;
    const accounts = this.accountManager.getAccounts();
    const activeAccount = this.accountManager.getActiveAccount();
    const overall = this.accountManager.getOverallSummary();

    this._view.webview.postMessage({
      type: 'stateUpdate',
      accounts,
      activeAccount,
      overall,
      autoSwitchEnabled: true
    });
  }

  private getHtmlContent(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Antigravity Swap</title>
  <style>
    :root {
      --bg-gradient: linear-gradient(145deg, #090d16 0%, #111827 100%);
      --card-bg: rgba(26, 34, 52, 0.7);
      --card-border: rgba(59, 130, 246, 0.2);
      --card-border-active: rgba(96, 165, 250, 0.8);
      --neon-blue: #38bdf8;
      --neon-purple: #a855f7;
      --neon-pink: #ec4899;
      --neon-green: #22c55e;
      --neon-amber: #f59e0b;
      --neon-red: #ef4444;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      user-select: none;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg-gradient);
      color: var(--text-main);
      padding: 12px;
      font-size: 12px;
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* Overall Quota Hero Banner */
    .hero-banner {
      background: radial-gradient(circle at 50% 0%, rgba(56, 189, 248, 0.15), transparent 70%),
                  linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(15, 23, 42, 0.9));
      border: 1px solid rgba(56, 189, 248, 0.3);
      border-radius: 16px;
      padding: 16px;
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 16px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 0 20px rgba(56, 189, 248, 0.1);
      backdrop-filter: blur(12px);
      position: relative;
      overflow: hidden;
    }

    .hero-banner::after {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: linear-gradient(45deg, transparent 45%, rgba(255,255,255,0.03) 50%, transparent 55%);
      pointer-events: none;
    }

    .radial-gauge {
      width: 72px;
      height: 72px;
      position: relative;
      flex-shrink: 0;
    }

    .radial-gauge svg {
      transform: rotate(-90deg);
      width: 72px;
      height: 72px;
    }

    .gauge-bg {
      fill: none;
      stroke: rgba(255, 255, 255, 0.08);
      stroke-width: 6;
    }

    .gauge-fill {
      fill: none;
      stroke: url(#gauge-gradient);
      stroke-width: 6;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.8s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .gauge-text {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 16px;
      font-weight: 800;
      color: #fff;
      text-shadow: 0 0 10px rgba(56, 189, 248, 0.5);
    }

    .hero-info {
      flex: 1;
    }

    .hero-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--neon-blue);
      font-weight: 700;
      margin-bottom: 2px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .hero-subtitle {
      font-size: 14px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 4px;
    }

    .hero-stats {
      display: flex;
      gap: 8px;
      font-size: 11px;
      color: var(--text-muted);
    }

    .stat-pill {
      background: rgba(255, 255, 255, 0.06);
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    /* Action Buttons Bar */
    .actions-bar {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 16px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 12px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.2s ease;
      text-decoration: none;
    }

    .btn-primary {
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      color: #fff;
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
    }

    .btn-primary:hover {
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(37, 99, 235, 0.4);
    }

    .btn-secondary {
      background: rgba(30, 41, 59, 0.8);
      color: #e2e8f0;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .btn-secondary:hover {
      background: rgba(51, 65, 85, 0.9);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .btn-icon {
      padding: 6px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: var(--text-muted);
      cursor: pointer;
    }

    .btn-icon:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.1);
    }

    /* Section Headers */
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      font-weight: 700;
    }

    /* Account Cards */
    .accounts-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 20px;
    }

    .account-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 12px;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
      cursor: pointer;
    }

    .account-card:hover {
      border-color: rgba(96, 165, 250, 0.5);
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.3);
    }

    .account-card.active {
      background: linear-gradient(135deg, rgba(30, 58, 138, 0.4), rgba(17, 24, 39, 0.8));
      border: 1.5px solid var(--card-border-active);
      box-shadow: 0 0 16px rgba(56, 189, 248, 0.25);
    }

    .account-card.active::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 4px;
      height: 100%;
      background: linear-gradient(to bottom, #38bdf8, #818cf8);
    }

    .acc-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }

    .acc-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: linear-gradient(135deg, #3b82f6, #ec4899);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      color: #fff;
      font-size: 13px;
      overflow: hidden;
      flex-shrink: 0;
      border: 1.5px solid rgba(255, 255, 255, 0.2);
    }

    .acc-avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .acc-meta {
      flex: 1;
      min-width: 0;
    }

    .acc-name-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .acc-name {
      font-weight: 700;
      font-size: 13px;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .active-badge {
      font-size: 9px;
      font-weight: 800;
      background: #0284c7;
      color: #fff;
      padding: 1px 6px;
      border-radius: 4px;
      letter-spacing: 0.05em;
    }

    .acc-email {
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .acc-quota-bar-wrapper {
      margin-top: 6px;
    }

    .acc-quota-label-row {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      margin-bottom: 4px;
    }

    .quota-pct {
      font-weight: 700;
      color: var(--neon-blue);
    }

    .progress-bar-bg {
      height: 6px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      overflow: hidden;
    }

    .progress-bar-fill {
      height: 100%;
      border-radius: 999px;
      transition: width 0.6s ease;
    }

    .fill-green { background: linear-gradient(90deg, #10b981, #22c55e); }
    .fill-amber { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
    .fill-red { background: linear-gradient(90deg, #ef4444, #f87171); }

    .acc-actions {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }

    /* Model Quotas Breakdown */
    .models-grid {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 20px;
    }

    .model-card {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 10px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .model-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .model-name {
      font-weight: 600;
      font-size: 12px;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .model-pill {
      font-size: 9px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(56, 189, 248, 0.15);
      color: var(--neon-blue);
    }

    .model-reset {
      font-size: 10px;
      color: var(--text-muted);
    }

    .model-bar-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .model-bar-row .progress-bar-bg {
      flex: 1;
    }

    .model-pct {
      font-size: 11px;
      font-weight: 700;
      width: 35px;
      text-align: right;
    }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 30px 16px;
      background: var(--card-bg);
      border-radius: 14px;
      border: 1px dashed rgba(255, 255, 255, 0.15);
      margin-bottom: 20px;
    }

    .empty-icon {
      font-size: 32px;
      margin-bottom: 10px;
    }

    .empty-text {
      color: var(--text-muted);
      font-size: 12px;
      margin-bottom: 14px;
    }
  </style>
</head>
<body>
  <!-- Hero Section: Overall Quota Across All Accounts -->
  <div class="hero-banner">
    <div class="radial-gauge">
      <svg viewBox="0 0 72 72">
        <defs>
          <linearGradient id="gauge-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#38bdf8" />
            <stop offset="50%" stop-color="#818cf8" />
            <stop offset="100%" stop-color="#ec4899" />
          </linearGradient>
        </defs>
        <circle class="gauge-bg" cx="36" cy="36" r="30" />
        <circle id="overall-gauge" class="gauge-fill" cx="36" cy="36" r="30" stroke-dasharray="188.5" stroke-dashoffset="188.5" />
      </svg>
      <div id="overall-pct-text" class="gauge-text">0%</div>
    </div>
    <div class="hero-info">
      <div class="hero-title">⚡ Antigravity Swap</div>
      <div class="hero-subtitle">Overall Total Quota</div>
      <div class="hero-stats">
        <span id="acc-count-pill" class="stat-pill">0 Accounts</span>
        <span id="active-acc-pill" class="stat-pill">No Active</span>
      </div>
    </div>
  </div>

  <!-- Action Bar -->
  <div class="actions-bar">
    <button class="btn btn-primary" onclick="addOAuth()">
      <span>+ Google Sign In</span>
    </button>
    <button class="btn btn-secondary" onclick="refreshAll()">
      <span>↻ Refresh Quotas</span>
    </button>
  </div>

  <!-- Accounts List Section -->
  <div class="section-header">
    <span>Accounts & Fast Switch</span>
    <button class="btn-icon" title="Add token manually" onclick="addManual()">+ Manual</button>
  </div>
  <div id="accounts-container" class="accounts-list">
    <!-- Rendered dynamically -->
  </div>

  <!-- Active Models Quota Breakdown -->
  <div class="section-header">
    <span id="models-title">Active Account Models</span>
  </div>
  <div id="models-container" class="models-grid">
    <!-- Rendered dynamically -->
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const circumference = 2 * Math.PI * 30; // ~188.5

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'stateUpdate') {
        renderState(msg);
      }
    });

    function addOAuth() {
      vscode.postMessage({ command: 'addOAuth' });
    }

    function addManual() {
      vscode.postMessage({ command: 'addManual' });
    }

    function refreshAll() {
      vscode.postMessage({ command: 'refreshAll' });
    }

    function switchAccount(email) {
      vscode.postMessage({ command: 'switchAccount', email });
    }

    function refreshAccount(event, email) {
      event.stopPropagation();
      vscode.postMessage({ command: 'refreshAccount', email });
    }

    function removeAccount(event, email) {
      event.stopPropagation();
      vscode.postMessage({ command: 'removeAccount', email });
    }

    function getFillClass(pct) {
      if (pct > 50) return 'fill-green';
      if (pct > 20) return 'fill-amber';
      return 'fill-red';
    }

    function renderState(state) {
      const overall = state.overall || { overallPercentage: 0, totalAccounts: 0 };
      const accounts = state.accounts || [];
      const activeAccount = state.activeAccount || accounts.find(a => a.isActive);

      // 1. Update Hero Gauge
      const overallPct = overall.overallPercentage || 0;
      document.getElementById('overall-pct-text').innerText = overallPct + '%';
      const offset = circumference - (overallPct / 100) * circumference;
      document.getElementById('overall-gauge').style.strokeDashoffset = offset;
      document.getElementById('acc-count-pill').innerText = \`\${accounts.length} Account\${accounts.length !== 1 ? 's' : ''}\`;
      document.getElementById('active-acc-pill').innerText = activeAccount ? (activeAccount.name || activeAccount.email.split('@')[0]) : 'None';

      // 2. Render Accounts
      const accContainer = document.getElementById('accounts-container');
      if (accounts.length === 0) {
        accContainer.innerHTML = \`
          <div class="empty-state">
            <div class="empty-icon">⚡</div>
            <div class="empty-text">No accounts connected yet. Add your first Google/Antigravity account to enable fast switching and quota tracking!</div>
            <button class="btn btn-primary" onclick="addOAuth()">+ Connect Google Account</button>
          </div>
        \`;
      } else {
        accContainer.innerHTML = accounts.map(acc => {
          const isAct = activeAccount && activeAccount.email === acc.email;
          const pct = acc.averageQuotaPercentage ?? 0;
          const fillClass = getFillClass(pct);
          const avatar = acc.avatarUrl
            ? \`<img src="\${acc.avatarUrl}" alt="\${acc.name}">\`
            : (acc.name ? acc.name.charAt(0).toUpperCase() : acc.email.charAt(0).toUpperCase());

          return \`
            <div class="account-card \${isAct ? 'active' : ''}" onclick="switchAccount('\${acc.email}')">
              <div class="acc-header">
                <div class="acc-avatar">\${avatar}</div>
                <div class="acc-meta">
                  <div class="acc-name-row">
                    <span class="acc-name">\${acc.name || acc.email}</span>
                    \${isAct ? '<span class="active-badge">ACTIVE</span>' : ''}
                  </div>
                  <div class="acc-email">\${acc.email}</div>
                </div>
              </div>
              <div class="acc-quota-bar-wrapper">
                <div class="acc-quota-label-row">
                  <span style="color: var(--text-muted)">Average Quota</span>
                  <span class="quota-pct">\${pct}%</span>
                </div>
                <div class="progress-bar-bg">
                  <div class="progress-bar-fill \${fillClass}" style="width: \${pct}%"></div>
                </div>
              </div>
              <div class="acc-actions">
                <button class="btn-icon" title="Refresh this account quota" onclick="refreshAccount(event, '\${acc.email}')">↻</button>
                <button class="btn-icon" title="Remove account" onclick="removeAccount(event, '\${acc.email}')">🗑</button>
                \${!isAct ? \`<button class="btn btn-primary" style="padding: 3px 8px; font-size: 10px;" onclick="switchAccount('\${acc.email}')">Switch</button>\` : ''}
              </div>
            </div>
          \`;
        }).join('');
      }

      // 3. Render Models for Active Account
      const modelsContainer = document.getElementById('models-container');
      const modelsTitle = document.getElementById('models-title');

      if (activeAccount && activeAccount.quotas && activeAccount.quotas.length > 0) {
        modelsTitle.innerText = \`Model Quotas (\${activeAccount.name || activeAccount.email.split('@')[0]})\`;
        modelsContainer.innerHTML = activeAccount.quotas.map(q => {
          const fillClass = getFillClass(q.percentage);
          const resetInfo = q.resetCountdown ? \`<span class="model-reset">Resets \${q.resetCountdown}</span>\` : '';
          return \`
            <div class="model-card">
              <div class="model-top">
                <span class="model-name">
                  \${q.displayName}
                </span>
                \${resetInfo}
              </div>
              <div class="model-bar-row">
                <div class="progress-bar-bg">
                  <div class="progress-bar-fill \${fillClass}" style="width: \${q.percentage}%"></div>
                </div>
                <span class="model-pct" style="color: \${q.percentage < 20 ? 'var(--neon-red)' : 'var(--text-main)'}">\${q.percentage}%</span>
              </div>
            </div>
          \`;
        }).join('');
      } else {
        modelsTitle.innerText = 'Model Quotas';
        modelsContainer.innerHTML = \`
          <div style="color: var(--text-muted); text-align: center; padding: 12px; font-size: 11px;">
            Select or connect an active account to see real-time model quotas.
          </div>
        \`;
      }
    }

    // Inform extension webview is ready
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }
}
