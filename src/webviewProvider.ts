import * as vscode from 'vscode';
import { AccountManager } from './accountManager';
import { HeartbeatService } from './heartbeatService';

export class WebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'antigravitySwap.dashboardView';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly accountManager: AccountManager,
    private readonly heartbeatService: HeartbeatService
  ) {
    this.accountManager.onDidChangeState(() => this.updateWebview());
    this.heartbeatService.onHeartbeat(() => this.updateWebview());
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
      console.log('[Antigravity Swap] Webview message:', data);
      try {
        switch (data.command) {
          case 'switchAccount':
            await this.accountManager.switchAccount(data.email, data.isManual === true);
            break;
          case 'reloginAccount':
            await this.accountManager.reloginAccount(data.email);
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
          case 'importCurrentAntigravity':
            await this.accountManager.importCurrentAntigravityAccount();
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
          case 'setAutoSwitch':
            await this.accountManager.setAutoSwitchEnabled(data.enabled);
            break;
          case 'ready':
            this.updateWebview();
            break;
        }
      } catch (err: any) {
        console.error('[Antigravity Swap] Webview command error:', err);
        vscode.window.showErrorMessage(`Action failed: ${err.message}`);
      }
    });

    this.updateWebview();
  }

  public updateWebview(): void {
    if (!this._view) return;
    const accounts = this.accountManager.getAccounts();
    const activeAccount = this.accountManager.getActiveAccount();
    const overall = this.accountManager.getOverallSummary();
    const heartbeat = this.heartbeatService.getHeartbeatInfo();

    this._view.webview.postMessage({
      type: 'stateUpdate',
      accounts,
      activeAccount,
      overall,
      heartbeat,
      autoSwitchEnabled: this.accountManager.isAutoSwitchEnabled()
    });
  }

  private getHtmlContent(_webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Antigravity Swap</title>
  <style>
    :root {
      --bg: #0b0f1a;
      --card-bg: rgba(20, 27, 45, 0.85);
      --card-border: rgba(59, 130, 246, 0.18);
      --card-border-active: rgba(96, 165, 250, 0.9);
      --card-border-selected: rgba(168, 85, 247, 0.8);
      --blue: #38bdf8;
      --purple: #a855f7;
      --pink: #ec4899;
      --green: #22c55e;
      --amber: #f59e0b;
      --red: #ef4444;
      --text: #f1f5f9;
      --muted: #64748b;
      --muted2: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 10px;
      font-size: 12px;
      line-height: 1.4;
      min-height: 100vh;
      user-select: none;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .spin-icon {
      display: inline-block;
      animation: spin 0.8s linear infinite;
    }

    .hero {
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(15, 23, 42, 0.98));
      border: 1px solid rgba(56, 189, 248, 0.25);
      border-radius: 14px;
      padding: 12px 14px;
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }
    .gauge {
      width: 60px;
      height: 60px;
      flex-shrink: 0;
      position: relative;
    }
    .gauge svg { transform: rotate(-90deg); }
    .gauge-bg { fill: none; stroke: rgba(255, 255, 255, 0.08); stroke-width: 5; }
    .gauge-fill {
      fill: none;
      stroke: url(#gg);
      stroke-width: 5;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.8s ease;
    }
    .gauge-label {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 14px;
      font-weight: 800;
      color: #fff;
    }
    .hero-body { flex: 1; min-width: 0; }
    .hero-tag {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--blue);
      font-weight: 700;
      margin-bottom: 1px;
    }
    .hero-title {
      font-size: 13px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .hero-pills { display: flex; flex-wrap: wrap; gap: 4px; }
    .pill {
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 999px;
      padding: 1px 7px;
      font-size: 10px;
      color: var(--muted2);
      white-space: nowrap;
    }
    .pill.pro {
      border-color: rgba(168, 85, 247, 0.4);
      color: var(--purple);
    }

    .quota-summary-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 10px;
    }
    .quota-summary-card {
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 10px;
      padding: 8px 10px;
    }
    .qs-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      font-weight: 700;
      margin-bottom: 4px;
    }
    .qs-pct {
      font-size: 18px;
      font-weight: 800;
      margin-bottom: 3px;
    }
    .qs-bar {
      height: 4px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      overflow: hidden;
    }
    .qs-bar-fill {
      height: 100%;
      border-radius: 999px;
      transition: width 0.6s ease;
    }

    /* Controller bar — flex-wrap row for all top action buttons */
    .ctrl-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-bottom: 10px;
    }
    .ctrl-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.15s ease;
      outline: none;
      font-family: inherit;
      white-space: nowrap;
    }
    .ctrl-btn-import  { background: linear-gradient(135deg, #0284c7, #0d9488); color: #fff; border-color: transparent; }
    .ctrl-btn-import:hover { filter: brightness(1.15); }
    .ctrl-btn-refresh { background: rgba(30, 41, 59, 0.9); color: #e2e8f0; border-color: rgba(255,255,255,0.1); }
    .ctrl-btn-refresh:hover { background: rgba(51, 65, 85, 0.9); }
    .ctrl-btn-signin  { background: linear-gradient(135deg, #2563eb, #7c3aed); color: #fff; border-color: transparent; }
    .ctrl-btn-signin:hover { filter: brightness(1.15); }
    /* Auto-switch inline toggle inside ctrl-bar */
    .ctrl-as {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 9px;
      border-radius: 8px;
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid rgba(255,255,255,0.09);
      cursor: pointer;
      font-size: 10px;
      font-weight: 600;
      color: var(--muted2);
      font-family: inherit;
      transition: border-color 0.15s;
    }
    .ctrl-as:hover { border-color: rgba(255,255,255,0.2); }
    .ctrl-as.active { border-color: rgba(3,105,161,0.6); color: #38bdf8; }
    .toggle-dot {
      width: 28px;
      height: 16px;
      border-radius: 999px;
      position: relative;
      transition: background 0.2s;
      flex-shrink: 0;
    }
    .toggle-dot.on  { background: #0369a1; }
    .toggle-dot.off { background: rgba(255,255,255,0.12); }
    .toggle-dot::after {
      content: '';
      position: absolute;
      top: 2px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #fff;
      transition: left 0.2s;
    }
    .toggle-dot.on::after  { left: 14px; }
    .toggle-dot.off::after { left: 2px; }

    .actions-grid {
      display: none; /* replaced by ctrl-bar */
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 8px 10px;
      border-radius: 9px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.18s ease;
      outline: none;
      text-align: center;
      font-family: inherit;
    }
    .btn-primary {
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      color: #fff;
    }
    .btn-primary:hover { filter: brightness(1.15); }
    .btn-import {
      background: linear-gradient(135deg, #0284c7, #0d9488);
      color: #fff;
    }
    .btn-import:hover { filter: brightness(1.15); }
    .btn-secondary {
      background: rgba(30, 41, 59, 0.9);
      color: #e2e8f0;
      border-color: rgba(255, 255, 255, 0.1);
    }
    .btn-secondary:hover { background: rgba(51, 65, 85, 0.9); border-color: rgba(255, 255, 255, 0.2); }
    .btn-relogin {
      background: linear-gradient(135deg, #d97706, #b45309);
      color: #fff;
      font-size: 10px;
      padding: 3px 8px;
      box-shadow: 0 2px 6px rgba(217, 119, 6, 0.35);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-family: inherit;
    }
    .btn-relogin:hover { filter: brightness(1.15); }
    .btn-switch {
      background: linear-gradient(135deg, #0284c7, #0369a1);
      color: #fff;
      font-size: 10px;
      padding: 3px 8px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 58px;
      justify-content: center;
    }
    .btn-switch:hover:not(:disabled) { filter: brightness(1.15); }
    .btn-switch:disabled { opacity: 0.75; cursor: not-allowed; }
    .btn-icon {
      padding: 4px 6px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.09);
      color: var(--muted2);
      cursor: pointer;
      font-size: 11px;
      font-family: inherit;
    }
    .btn-icon:hover { color: #fff; background: rgba(255, 255, 255, 0.12); }

    .section-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      font-weight: 700;
      margin: 10px 0 6px 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .acc-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 8px;
      margin-bottom: 14px;
    }
    /* BASE / NORMAL STATE (UNSELECTED NON-ACTIVE) */
    .acc-card {
      background: hsl(220, 24%, 12%);
      border: 1px solid hsla(220, 20%, 24%, 0.6);
      border-radius: 12px;
      padding: 10px;
      transition: background 0.15s ease, border-color 0.15s ease, transform 0.08s ease, box-shadow 0.15s ease;
      position: relative;
      overflow: hidden;
      cursor: pointer;
    }

    /* SELECTED NON-ACTIVE: Neutral lifted slate card with crisp subtle border (no cyan tint) */
    .acc-card.selected:not(.active) {
      background: hsl(220, 22%, 16%);
      border: 1.5px solid hsla(220, 20%, 55%, 0.45);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    }

    /* HOVER STATE: subtle gentle lift in lightness */
    .acc-card:not(.active):hover {
      background: hsl(220, 24%, 18%);
      border-color: hsla(220, 25%, 65%, 0.6);
    }

    /* CSS :ACTIVE (MOUSEDOWN / CLICK): micro feedback */
    .acc-card:not(.active):active {
      background: hsl(220, 26%, 21%);
      border-color: hsla(220, 30%, 75%, 0.75);
      transform: scale(0.996);
    }

    /* ACTIVE ACCOUNT (NORMAL / UNSELECTED): Subdued navy with distinct cyan indicator bar */
    .acc-card.active:not(.selected) {
      background: hsl(212, 38%, 14%);
      border: 1.5px solid hsla(200, 55%, 38%, 0.45);
    }
    .acc-card.active::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 3px;
      height: 100%;
      background: linear-gradient(to bottom, #38bdf8, #818cf8);
    }

    /* ACTIVE ACCOUNT (SELECTED): Vivid active navy with luminous cyan border */
    .acc-card.active.selected {
      background: hsl(212, 45%, 18%);
      border: 1.5px solid hsla(200, 80%, 55%, 0.75);
      box-shadow: 0 4px 12px hsla(200, 70%, 25%, 0.25);
    }

    /* ACTIVE ACCOUNT (HOVER): Gentle highlight */
    .acc-card.active:hover {
      background: hsl(212, 48%, 21%);
      border-color: hsla(200, 85%, 65%, 0.85);
    }

    /* ACTIVE ACCOUNT CSS :ACTIVE (MOUSEDOWN / CLICK) */
    .acc-card.active:active {
      background: hsl(212, 52%, 24%);
      border-color: hsla(200, 90%, 72%, 0.95);
      transform: scale(0.996);
    }

    .acc-card.banned {
      border-color: rgba(239, 68, 68, 0.5);
      background: rgba(60, 12, 12, 0.45);
    }
    .acc-card.banned.selected {
      border-color: rgba(239, 68, 68, 0.8);
      background: rgba(80, 16, 16, 0.6);
      box-shadow: 0 4px 14px rgba(239, 68, 68, 0.2);
    }
    .acc-card.banned:hover {
      border-color: rgba(239, 68, 68, 0.95);
      background: rgba(95, 20, 20, 0.7);
    }
    .acc-card.banned:active {
      background: rgba(115, 24, 24, 0.85);
      transform: scale(0.985);
    }

    .acc-card.auth-failed {
      border-color: rgba(245, 158, 11, 0.4);
      background: rgba(45, 30, 10, 0.45);
    }
    .acc-card.auth-failed.selected {
      border-color: rgba(245, 158, 11, 0.75);
      background: rgba(65, 42, 12, 0.6);
      box-shadow: 0 4px 14px rgba(245, 158, 11, 0.2);
    }
    .acc-card.auth-failed:hover {
      border-color: rgba(245, 158, 11, 0.9);
      background: rgba(80, 52, 15, 0.7);
    }
    .acc-card.auth-failed:active {
      background: rgba(95, 62, 18, 0.85);
      transform: scale(0.985);
    }

    .acc-top {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .acc-avatar {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: linear-gradient(135deg, #3b82f6, #ec4899);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      color: #fff;
      font-size: 12px;
      flex-shrink: 0;
      border: 1.5px solid rgba(255, 255, 255, 0.18);
      overflow: hidden;
    }
    .acc-avatar img { width: 100%; height: 100%; object-fit: cover; }
    .acc-info { flex: 1; min-width: 0; }
    .acc-name-row {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-wrap: wrap;
      margin-bottom: 1px;
      padding-right: 52px;
    }
    .acc-name {
      font-weight: 700;
      font-size: 12px;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .acc-email {
      font-size: 10px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .acc-status-msg {
      font-size: 10px;
      color: var(--amber);
      margin-top: 2px;
    }

    .badge {
      font-size: 8px;
      font-weight: 800;
      padding: 1px 5px;
      border-radius: 4px;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }
    .badge-active     { background: #0369a1; color: #fff; }
    .badge-banned     { background: #dc2626; color: #fff; }
    .badge-auth       { background: #b45309; color: #fff; }
    .badge-pro        { background: linear-gradient(90deg, #7c3aed, #ec4899); color: #fff; }
    .badge-premium    { background: linear-gradient(90deg, #0284c7, #7c3aed); color: #fff; }
    .badge-enterprise { background: linear-gradient(90deg, #065f46, #0369a1); color: #fff; }
    .badge-selected {
      position: absolute;
      top: 7px;
      right: 8px;
      font-size: 9px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 4px;
      letter-spacing: 0;
      background: rgba(255, 255, 255, 0.12);
      border: 1px solid rgba(255, 255, 255, 0.28);
      color: rgba(255, 255, 255, 0.9);
      pointer-events: none;
    }

    .acc-quota-section { margin-top: 6px; }
    .acc-quota-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 5px;
    }
    .qtab {
      flex: 1;
      text-align: center;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      padding: 3px 4px;
    }
    .qtab-label {
      color: var(--muted);
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .qtab-val {
      font-weight: 800;
      font-size: 13px;
      margin-top: 1px;
    }
    .bar-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .bar-bg {
      flex: 1;
      height: 5px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      border-radius: 999px;
      transition: width 0.6s ease;
    }
    .bar-pct {
      font-size: 10px;
      font-weight: 700;
      width: 32px;
      text-align: right;
    }
    .fill-green { background: linear-gradient(90deg, #10b981, #22c55e); }
    .fill-amber { background: linear-gradient(90deg, #d97706, #f59e0b); }
    .fill-red   { background: linear-gradient(90deg, #dc2626, #ef4444); }

    .acc-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 5px;
      margin-top: 7px;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }
    .acc-type-label {
      flex: 1;
      font-size: 10px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .model-section { margin-bottom: 14px; }
    .model-window-group { margin-bottom: 10px; }
    .model-window-title {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      font-weight: 700;
      margin-bottom: 5px;
    }
    .model-cards {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .model-card {
      background: rgba(13, 18, 32, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 8px;
      padding: 7px 10px;
    }
    .model-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .model-name { font-weight: 600; font-size: 11px; color: #e2e8f0; }
    .model-reset { font-size: 9px; color: var(--muted); }

    .empty {
      text-align: center;
      padding: 24px 12px;
      background: var(--card-bg);
      border: 1px dashed rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      margin-bottom: 12px;
    }
    .empty-icon { font-size: 28px; margin-bottom: 8px; }
    .empty-text { color: var(--muted2); font-size: 11px; margin-bottom: 12px; }

    .notice-box {
      padding: 10px 12px;
      border-radius: 8px;
      text-align: center;
      font-size: 11px;
      line-height: 1.5;
    }
    .notice-auth {
      background: rgba(217, 119, 6, 0.12);
      border: 1px dashed rgba(217, 119, 6, 0.35);
      color: var(--amber);
    }
    .notice-ban {
      background: rgba(239, 68, 68, 0.12);
      border: 1px dashed rgba(239, 68, 68, 0.35);
      color: var(--red);
    }
    .notice-info {
      background: rgba(255, 255, 255, 0.04);
      border: 1px dashed rgba(255, 255, 255, 0.1);
      color: var(--muted);
    }

    /* Auto-switch toggle row */
    .auto-switch-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 8px;
      padding: 6px 10px;
      margin-bottom: 8px;
      gap: 8px;
    }
    .auto-switch-label {
      font-size: 10px;
      color: var(--muted2);
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 5px;
      flex: 1;
    }
    .auto-switch-label .as-title { color: var(--text); font-weight: 700; }
    .toggle-pill {
      width: 36px;
      height: 20px;
      border-radius: 999px;
      border: none;
      cursor: pointer;
      position: relative;
      transition: background 0.2s ease;
      flex-shrink: 0;
      outline: none;
    }
    .toggle-pill.on  { background: #0369a1; }
    .toggle-pill.off { background: rgba(255, 255, 255, 0.12); }
    .toggle-pill::after {
      content: '';
      position: absolute;
      top: 3px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #fff;
      transition: left 0.2s ease;
    }
    .toggle-pill.on::after  { left: 19px; }
    .toggle-pill.off::after { left: 3px; }
  </style>
</head>
<body>

  <!-- Top Hero Card -->
  <div class="hero">
    <div class="gauge">
      <svg width="60" height="60" viewBox="0 0 60 60">
        <defs>
          <linearGradient id="gg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%"   stop-color="#38bdf8"/>
            <stop offset="50%"  stop-color="#818cf8"/>
            <stop offset="100%" stop-color="#ec4899"/>
          </linearGradient>
        </defs>
        <circle class="gauge-bg" cx="30" cy="30" r="26"/>
        <circle id="overall-gauge" class="gauge-fill" cx="30" cy="30" r="26"
          stroke-dasharray="163.4" stroke-dashoffset="163.4"/>
      </svg>
      <div id="overall-pct-label" class="gauge-label">0%</div>
    </div>
    <div class="hero-body">
      <div class="hero-tag">&#9889; Antigravity Swap</div>
      <div id="hero-title" class="hero-title">Overall Quota</div>
      <div class="hero-pills">
        <span id="pill-accounts" class="pill">0 Accounts</span>
        <span id="pill-healthy"  class="pill">0 Healthy</span>
        <span id="pill-pro"      class="pill pro" style="display:none">0 Pro</span>
      </div>
    </div>
  </div>

  <!-- 5-Hour and Weekly Overall Cards -->
  <div class="quota-summary-row">
    <div class="quota-summary-card">
      <div class="qs-label">&#9201; 5h Window</div>
      <div id="qs-5h-pct" class="qs-pct" style="color:var(--blue)">&mdash;</div>
      <div class="qs-bar"><div id="qs-5h-bar" class="qs-bar-fill fill-green" style="width:0%"></div></div>
    </div>
    <div class="quota-summary-card">
      <div class="qs-label">&#128197; Weekly</div>
      <div id="qs-wk-pct" class="qs-pct" style="color:var(--purple)">&mdash;</div>
      <div class="qs-bar"><div id="qs-wk-bar" class="qs-bar-fill" style="width:0%;background:linear-gradient(90deg,#7c3aed,#a855f7)"></div></div>
    </div>
  </div>


  <!-- Controller Bar: all top action buttons in one flex-wrap row -->
  <div class="ctrl-bar">
    <button class="ctrl-btn ctrl-btn-import" id="btn-import-top">&#9889; Import Antigravity</button>
    <button class="ctrl-btn ctrl-btn-refresh" id="btn-refresh-top">&#8635; Refresh Quotas</button>
    <button class="ctrl-btn ctrl-btn-signin" id="btn-oauth-top">+ Google Sign In</button>
    <button class="ctrl-as off" id="btn-auto-switch" title="Toggle auto-switch when quota is low">
      <span class="toggle-dot off" id="as-dot"></span>Auto-Switch
    </button>
  </div>

  <!-- Accounts Section -->
  <div class="section-label">
    <span>Accounts &amp; Fast Switch</span>
    <button class="btn-icon" id="btn-manual-top" title="Add via token">+ Manual</button>
  </div>
  <div id="acc-container" class="acc-list"></div>

  <!-- Model Breakdown Section -->
  <div class="section-label">
    <span id="models-title">Model Quotas</span>
  </div>
  <div id="models-container" class="model-section"></div>

<script>
(function() {
  const vscode = acquireVsCodeApi();
  const CIRC = 2 * Math.PI * 26;

  let currentAccounts = [];
  let currentActive = null;
  let selectedEmail = null;

  document.getElementById('btn-import-top').addEventListener('click', function() {
    vscode.postMessage({ command: 'importCurrentAntigravity' });
  });

  document.getElementById('btn-refresh-top').addEventListener('click', function() {
    const btn = document.getElementById('btn-refresh-top');
    if (btn) {
      btn.innerHTML = '<span class="spin-icon">&#8635;</span> Refreshing...';
      btn.disabled = true;
    }
    vscode.postMessage({ command: 'refreshAll' });
  });

  document.getElementById('btn-oauth-top').addEventListener('click', function() {
    vscode.postMessage({ command: 'addOAuth' });
  });

  document.getElementById('btn-manual-top').addEventListener('click', function() {
    vscode.postMessage({ command: 'addManual' });
  });

  var autoSwitchBtn = document.getElementById('btn-auto-switch');
  var asDot = document.getElementById('as-dot');
  autoSwitchBtn.addEventListener('click', function() {
    var nowEnabled = autoSwitchBtn.classList.contains('off');
    setAutoSwitchUi(nowEnabled);
    vscode.postMessage({ command: 'setAutoSwitch', enabled: nowEnabled });
  });

  function setAutoSwitchUi(enabled) {
    if (enabled) {
      autoSwitchBtn.classList.remove('off');
      autoSwitchBtn.classList.add('active');
      if (asDot) { asDot.classList.remove('off'); asDot.classList.add('on'); }
    } else {
      autoSwitchBtn.classList.remove('active');
      autoSwitchBtn.classList.add('off');
      if (asDot) { asDot.classList.remove('on'); asDot.classList.add('off'); }
    }
  }

  window.addEventListener('message', function(ev) {
    if (ev.data && ev.data.type === 'stateUpdate') {
      renderState(ev.data);
    }
  });

  function fillClass(p) { return p > 50 ? 'fill-green' : p > 20 ? 'fill-amber' : 'fill-red'; }
  function pctColor(p)  { return p > 50 ? 'var(--green)' : p > 20 ? 'var(--amber)' : 'var(--red)'; }

  function renderState(state) {
    const refreshTop = document.getElementById('btn-refresh-top');
    if (refreshTop) {
      refreshTop.innerHTML = '&#8635; Refresh Quotas';
      refreshTop.disabled = false;
    }

    const overall  = state.overall  || {};
    currentAccounts = state.accounts || [];
    currentActive   = state.activeAccount || null;

    // Sync auto-switch toggle from real state
    setAutoSwitchUi(state.autoSwitchEnabled !== false);

    // Preserve selection or default to active account
    if (!selectedEmail || !currentAccounts.some(function(a) { return a.email === selectedEmail; })) {
      selectedEmail = currentActive ? currentActive.email : (currentAccounts[0] ? currentAccounts[0].email : null);
    }

    const pct = overall.overallPercentage || 0;
    document.getElementById('overall-pct-label').innerText = pct + '%';
    document.getElementById('overall-gauge').style.strokeDashoffset = CIRC - (pct / 100) * CIRC;
    const healthyAccounts = currentAccounts.filter(function(a) {
      return !a.isBanned && a.status !== 'banned' && a.status !== 'auth_failed';
    });
    document.getElementById('pill-accounts').innerText = currentAccounts.length + ' Account' + (currentAccounts.length !== 1 ? 's' : '');
    document.getElementById('pill-healthy').innerText  = healthyAccounts.length + ' Healthy';

    const proEl = document.getElementById('pill-pro');
    if ((overall.proAccountsCount || 0) > 0) {
      proEl.style.display = '';
      proEl.innerText = overall.proAccountsCount + ' Pro';
    } else {
      proEl.style.display = 'none';
    }

    const fhPct = overall.overall5HourPercentage;
    const wkPct = overall.overallWeeklyPercentage;
    if (fhPct != null && (overall.proAccountsCount || 0) > 0) {
      document.getElementById('qs-5h-pct').innerText = fhPct + '%';
      document.getElementById('qs-5h-bar').style.width = (fhPct || 0) + '%';
      document.getElementById('qs-5h-bar').className = 'qs-bar-fill ' + fillClass(fhPct || 0);
    } else {
      document.getElementById('qs-5h-pct').innerText = 'N/A';
      document.getElementById('qs-5h-bar').style.width = '0%';
    }

    if (wkPct != null && wkPct > 0) {
      document.getElementById('qs-wk-pct').innerText = wkPct + '%';
      document.getElementById('qs-wk-bar').style.width = (wkPct || 0) + '%';
    } else {
      document.getElementById('qs-wk-pct').innerText = 'N/A';
      document.getElementById('qs-wk-bar').style.width = '0%';
    }

    const container = document.getElementById('acc-container');
    if (currentAccounts.length === 0) {
      container.innerHTML = '<div class="empty">' +
        '<div class="empty-icon">&#9889;</div>' +
        '<div class="empty-text">No accounts connected. Import from current Antigravity or sign in!</div>' +
        '<button class="btn btn-import" id="btn-empty-import" style="margin-bottom:6px;">&#9889; Import Antigravity Account</button>' +
        '<div><button class="btn btn-primary" id="btn-empty-oauth">+ Google Sign In</button></div>' +
        '</div>';
      const emptyImp = document.getElementById('btn-empty-import');
      if (emptyImp) emptyImp.onclick = function() { vscode.postMessage({ command: 'importCurrentAntigravity' }); };
      const emptyOauth = document.getElementById('btn-empty-oauth');
      if (emptyOauth) emptyOauth.onclick = function() { vscode.postMessage({ command: 'addOAuth' }); };
    } else {
      container.innerHTML = currentAccounts.map(function(acc) {
        return renderAccountCard(acc, currentActive, selectedEmail);
      }).join('');
      attachAccountEvents(container);
    }

    const selectedAcc = currentAccounts.find(function(a) { return a.email === selectedEmail; }) || currentActive;
    renderModelSection(selectedAcc, currentActive);
  }

  function tierBadgeHtml(acc) {
    const tier = acc.tierBadge;
    if (!tier || tier === 'STANDARD FREE') return '';
    if (tier === 'ENTERPRISE') return '<span class="badge badge-enterprise">ENTERPRISE</span>';
    if (tier === 'AI PREMIUM') return '<span class="badge badge-premium">AI PREMIUM</span>';
    if (tier === 'PRO')        return '<span class="badge badge-pro">PRO</span>';
    return '';
  }

  function renderAccountCard(acc, active, selected) {
    const isActive     = active && active.email === acc.email;
    const isSelected   = selected && selected === acc.email;
    const isBanned     = acc.isBanned || acc.status === 'banned';
    const isAuthFailed = acc.status === 'auth_failed';
    const pct          = acc.averageQuotaPercentage || 0;
    const fhPct        = acc.fiveHourQuotaPercentage;
    const wkPct        = acc.weeklyQuotaPercentage;
    const hasWk        = acc.hasWeeklyQuota;
    const isFree       = !acc.tierBadge || acc.tierBadge === 'STANDARD FREE';
    const fc           = fillClass(pct);
    const avatar       = acc.avatarUrl
      ? '<img src="' + acc.avatarUrl + '" alt="' + (acc.name || '') + '">'
      : (acc.name ? acc.name[0].toUpperCase() : acc.email[0].toUpperCase());

    let badges = '';
    if (isActive) {
      badges += '<span class="badge badge-active">ACTIVE</span>';
    }
    if (isBanned) {
      badges += '<span class="badge badge-banned">&#9940; BANNED</span>';
    } else if (isAuthFailed) {
      badges += '<span class="badge badge-auth">&#9888; AUTH FAILED</span>';
    }
    badges += tierBadgeHtml(acc);

    let cardClass = 'acc-card';
    if (isActive)      cardClass += ' active';
    if (isSelected)    cardClass += ' selected';
    if (isBanned)      cardClass += ' banned';
    if (isAuthFailed)  cardClass += ' auth-failed';

    let quotaHtml = '';
    if (isBanned) {
      quotaHtml = '<div style="color:var(--red);font-size:11px;padding:3px 0;font-weight:500;">&#9940; Account banned / suspended. Quota unavailable.</div>';
    } else if (isAuthFailed) {
      quotaHtml = '<div style="color:var(--amber);font-size:11px;padding:3px 0;font-weight:500;">&#9888; Authentication required. Click Re-login to load quotas.</div>';
    } else if (!isFree && hasWk && fhPct != null && wkPct != null) {
      quotaHtml = '<div class="acc-quota-tabs">' +
        '<div class="qtab"><div class="qtab-label">&#9201; 5h Window</div><div class="qtab-val" style="color:' + pctColor(fhPct) + '">' + fhPct + '%</div></div>' +
        '<div class="qtab"><div class="qtab-label">&#128197; Weekly</div><div class="qtab-val" style="color:' + pctColor(wkPct) + '">' + wkPct + '%</div></div>' +
        '</div>' +
        '<div class="bar-row"><div class="bar-bg"><div class="bar-fill ' + fc + '" style="width:' + pct + '%"></div></div><span class="bar-pct" style="color:' + pctColor(pct) + '">' + pct + '%</span></div>';
    } else {
      const label = (!isFree && fhPct != null) ? '&#9201; 5h: ' + fhPct + '%' : (hasWk && wkPct != null ? '&#128197; Weekly: ' + wkPct + '%' : 'Quota Remaining: ' + pct + '%');
      quotaHtml = '<div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:3px;"><span style="color:var(--muted)">' + label + '</span><span style="font-weight:700;color:' + pctColor(pct) + '">' + pct + '%</span></div>' +
        '<div class="bar-row"><div class="bar-bg"><div class="bar-fill ' + fc + '" style="width:' + pct + '%"></div></div></div>';
    }

    const switchBtn = (!isActive && !isBanned && !isAuthFailed)
      ? '<button class="btn-switch btn-action-switch" data-email="' + acc.email + '">Switch</button>'
      : '';

    // Only show re-login button for auth_failed accounts! Healthy accounts do not need it.
    const reloginBtn = isAuthFailed
      ? '<button class="btn-relogin btn-action-relogin" data-email="' + acc.email + '">&#128273; Re-login</button>'
      : '';

    const selectedBadge = isSelected ? '<span class="badge-selected">Selected</span>' : '';

    return '<div class="' + cardClass + '" data-card-email="' + acc.email + '">' +
      selectedBadge +
      '<div class="acc-top">' +
        '<div class="acc-avatar">' + avatar + '</div>' +
        '<div class="acc-info">' +
          '<div class="acc-name-row"><span class="acc-name">' + (acc.name || acc.email) + '</span>' + badges + '</div>' +
          '<div class="acc-email">' + acc.email + '</div>' +
          (acc.statusMessage ? '<div class="acc-status-msg">' + acc.statusMessage + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="acc-quota-section">' + quotaHtml + '</div>' +
      '<div class="acc-actions">' +
        '<span class="acc-type-label">' + (acc.accountType || 'Standard Free') + '</span>' +
        reloginBtn +
        '<button class="btn-icon btn-action-refresh" data-email="' + acc.email + '" title="Refresh quota">&#8635;</button>' +
        '<button class="btn-icon btn-action-remove" data-email="' + acc.email + '" title="Remove">&#128465;</button>' +
        switchBtn +
      '</div>' +
    '</div>';
  }

  function attachAccountEvents(container) {
    // Clicking on account card SELECTS that account (does NOT auto-switch)
    container.querySelectorAll('.acc-card').forEach(function(card) {
      card.addEventListener('click', function(e) {
        if (e.target.closest('button')) return;
        const email = card.getAttribute('data-card-email');
        if (!email) return;

        selectedEmail = email;

        // Update selected class and badge instantly
        container.querySelectorAll('.acc-card').forEach(function(c) {
          const isThis = c.getAttribute('data-card-email') === email;
          c.classList.toggle('selected', isThis);
          let b = c.querySelector('.badge-selected');
          if (isThis && !b) {
            const badgeSpan = document.createElement('span');
            badgeSpan.className = 'badge-selected';
            badgeSpan.innerText = 'Selected';
            c.insertBefore(badgeSpan, c.firstChild);
          } else if (!isThis && b) {
            b.remove();
          }
        });

        const targetAcc = currentAccounts.find(function(a) { return a.email === email; });
        if (targetAcc) {
          renderModelSection(targetAcc, currentActive);
        }
      });
    });

    // ONLY Switch button triggers account switch and shows rotating spinner
    container.querySelectorAll('.btn-action-switch').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const email = btn.getAttribute('data-email');
        if (email) {
          btn.disabled = true;
          btn.innerHTML = '<span class="spin-icon">&#8635;</span> Switching...';
          vscode.postMessage({ command: 'switchAccount', email: email, isManual: true });
        }
      });
    });

    container.querySelectorAll('.btn-action-relogin').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const email = btn.getAttribute('data-email');
        if (email) vscode.postMessage({ command: 'reloginAccount', email: email });
      });
    });

    container.querySelectorAll('.btn-action-refresh').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const email = btn.getAttribute('data-email');
        if (email) {
          btn.innerHTML = '<span class="spin-icon">&#8635;</span>';
          vscode.postMessage({ command: 'refreshAccount', email: email });
        }
      });
    });

    container.querySelectorAll('.btn-action-remove').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const email = btn.getAttribute('data-email');
        if (email) vscode.postMessage({ command: 'removeAccount', email: email });
      });
    });
  }

  function renderModelSection(target, active) {
    const title = document.getElementById('models-title');
    const container = document.getElementById('models-container');

    if (!target) {
      title.innerText = 'Model Quotas';
      container.innerHTML = '<div class="notice-box notice-info">Select an account above to view model quotas.</div>';
      return;
    }

    const isCurrentActive = active && active.email === target.email;
    const labelSuffix = isCurrentActive ? ' (Active)' : ' (Selected)';
    title.innerText = 'Model Quotas \u00b7 ' + (target.name || target.email.split('@')[0]) + labelSuffix;

    if (target.status === 'auth_failed') {
      container.innerHTML = '<div class="notice-box notice-auth">&#9888; Credentials expired or missing for <strong>' + (target.name || target.email) + '</strong>.<br>Click <strong>Re-login</strong> or <strong>Import Antigravity</strong> to authenticate and load quotas.</div>';
      return;
    }

    if (target.isBanned || target.status === 'banned') {
      container.innerHTML = '<div class="notice-box notice-ban">&#9940; Account <strong>' + (target.name || target.email) + '</strong> is suspended by Google Terms of Service.<br>Model quotas are inaccessible.</div>';
      return;
    }

    if (!target.quotas || target.quotas.length === 0) {
      container.innerHTML = '<div class="notice-box notice-info">No quota breakdown loaded for this account.<br>Click <strong>&#8635; Refresh Quotas</strong> to query server.</div>';
      return;
    }

    // Filter out fast autocomplete and thinking effort - only show primary AI models
    const validQuotas = target.quotas.filter(function(q) {
      const s = (q.id + ' ' + (q.displayName || '')).toLowerCase();
      return (
        !s.includes('tab_') &&
        !s.includes('autocomplete') &&
        !s.includes('tab completion') &&
        !s.includes('thinking effort') &&
        !s.includes('thinking_effort') &&
        !s.includes('thinking-effort') &&
        !s.includes('thinking budget') &&
        !s.includes('thinking_budget') &&
        !s.includes('thinking-budget')
      );
    });

    function getModelRank(q) {
      const s = (q.id + ' ' + (q.displayName || '')).toLowerCase();
      if (s.includes('3.8-flash') || s.includes('3.8 flash')) return 10;
      if (s.includes('3.7-flash') || s.includes('3.7 flash')) return 20;
      if (s.includes('3.6-flash') || s.includes('3.6 flash')) return 30;
      if (s.includes('3.1-flash') || s.includes('3.1 flash')) return 40;
      if (s.includes('3.5-flash') || s.includes('3.5 flash')) return 45; // fallback
      if (s.includes('gemini-3-flash') || s.includes('gemini 3 flash') || s.includes('gemini-3.0-flash')) return 50;
      if (s.includes('gemini') && s.includes('flash')) return 60;
      if (s.includes('gemini') && s.includes('pro')) return 70;
      if (s.includes('gemini')) return 80;
      if (s.includes('claude') && (s.includes('sonnet-4-6') || s.includes('sonnet 4.6') || s.includes('sonnet'))) return 100;
      if (s.includes('claude') && (s.includes('opus-4-6') || s.includes('opus 4.6') || s.includes('opus'))) return 110;
      if (s.includes('claude')) return 130;
      if (s.includes('gpt-oss') || s.includes('gpt_oss') || s.includes('gpt oss')) return 200;
      return 500;
    }


    const isFree = !target.tierBadge || target.tierBadge === 'STANDARD FREE';
    const sortedQuotas = [...validQuotas].sort(function(a, b) { return getModelRank(a) - getModelRank(b); });

    let html = '';
    if (isFree) {
      html += renderModelGroup('Standard Model Quotas', sortedQuotas);
    } else {
      const fiveHour = sortedQuotas.filter(function(q) { return q.windowType === '5h'; });
      const weekly   = sortedQuotas.filter(function(q) { return q.windowType === 'weekly'; });
      const other    = sortedQuotas.filter(function(q) { return q.windowType !== '5h' && q.windowType !== 'weekly'; });

      if (fiveHour.length > 0) html += renderModelGroup('&#9201; 5-Hour Rolling Window', fiveHour);
      if (weekly.length   > 0) html += renderModelGroup('&#128197; Weekly Plan Quota', weekly);
      if (other.length    > 0) html += renderModelGroup('&#128202; Additional Models', other);
    }

    container.innerHTML = html || '<div class="notice-box notice-info">No model quotas available for this account.</div>';
  }

  function renderModelGroup(groupTitle, quotas) {
    const cards = quotas.map(function(q) {
      // Sentinel value -1 means free tier placeholder (no API quota data)
      const isFreePlaceholder = q.percentage === -1 || q.remainingFraction === -1;
      if (isFreePlaceholder) {
        return '<div class="model-card">' +
          '<div class="model-top"><span class="model-name">' + q.displayName + '</span>' +
          '<span class="model-reset" style="color:var(--green);font-weight:600;">Free Tier</span></div>' +
          '<div style="font-size:10px;color:var(--muted);margin-top:2px;font-style:italic;">Quota data not exposed by API for free accounts</div>' +
          '</div>';
      }
      const fc = fillClass(q.percentage);
      const pctCol = pctColor(q.percentage);
      const resetHtml = q.resetCountdown ? '<span class="model-reset">Resets ' + q.resetCountdown + '</span>' : '';
      return '<div class="model-card">' +
        '<div class="model-top"><span class="model-name">' + q.displayName + '</span>' + resetHtml + '</div>' +
        '<div class="bar-row"><div class="bar-bg"><div class="bar-fill ' + fc + '" style="width:' + q.percentage + '%"></div></div><span class="bar-pct" style="color:' + pctCol + '">' + q.percentage + '%</span></div>' +
        '</div>';
    }).join('');
    return '<div class="model-window-group"><div class="model-window-title">' + groupTitle + '</div><div class="model-cards">' + cards + '</div></div>';
  }


  vscode.postMessage({ command: 'ready' });
})();
</script>
</body>
</html>`;
  }
}

