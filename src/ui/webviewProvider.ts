import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AccountService } from '../account';
import { HeartbeatService } from '../heartbeat';
import { EXTENSION_DEFAULTS } from '../constants';

export class WebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'antigravitySwap.dashboardView';
  private _view?: vscode.WebviewView;
  private _panel?: vscode.WebviewPanel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly accountService: AccountService,
    private readonly heartbeatService: HeartbeatService
  ) {
    this.accountService.onDidChangeState(() => this.updateWebview());
    this.heartbeatService.onHeartbeat(() => this.updateWebview());
    vscode.window.onDidChangeActiveColorTheme((theme) => {
      this.sendThemeUpdate(theme);
    });
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

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.updateWebview();
      }
    });

    webviewView.webview.onDidReceiveMessage((data) => this.handleWebviewMessage(data));

    this.updateWebview();
  }

  /**
   * Opens or reveals the Dashboard and automatically detaches it into a real native OS window.
   */
  public async openDetachedPanel(): Promise<void> {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Active);
      try {
        await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      } catch {}
      return;
    }

    this._panel = vscode.window.createWebviewPanel(
      'antigravitySwap.detachedDashboard',
      'Antigravity Swap Dashboard',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri]
      }
    );

    this._panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png'),
      dark: vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png')
    };

    this._panel.webview.html = this.getHtmlContent(this._panel.webview);

    this._panel.webview.onDidReceiveMessage((data) => this.handleWebviewMessage(data));

    this._panel.onDidDispose(() => {
      this._panel = undefined;
    });

    // Send initial state to newly opened panel
    this.updateWebview();

    // Automatically detach the editor tab into a separate native floating OS window
    setTimeout(async () => {
      try {
        await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      } catch (e) {
        console.warn('[Antigravity Swap] Could not auto-move to new window:', e);
      }
    }, 100);
  }

  private async handleWebviewMessage(data: any): Promise<void> {
    console.log('[Antigravity Swap] Webview message:', data);
    try {
      switch (data.command) {
        case 'popOut':
          this.openDetachedPanel();
          break;
        case 'openUrl':
          if (data.url) {
            vscode.env.openExternal(vscode.Uri.parse(data.url));
          }
          break;
        case 'switchAccount': {
          const ok = await this.accountService.switchAccount(data.email, data.isManual === true, true);
          if (ok) {
            this.showToast(`Switched to: ${data.email}!`, 'success');
          } else {
            const acc = this.accountService.getAccounts().find((a) => a.email === data.email);
            const msg = acc?.statusMessage || `Failed to switch to ${data.email}.`;
            this.showToast(msg, 'error');
          }
          break;
        }
        case 'relogin':
        case 'reloginAccount':
          await this.accountService.reloginAccount(data.email);
          break;
        case 'refreshAll': {
          try {
            const accounts = this.accountService.getAccounts();
            if (accounts.length === 0) {
              this.showToast('No accounts available to refresh.', 'info');
              break;
            }
            await this.accountService.refreshAllQuotas(true);
            const latest = this.accountService.getAccounts();
            const failedCount = latest.filter((a) => a.status === 'auth_failed' || a.status === 'banned').length;
            if (failedCount > 0) {
              this.showToast(`Refreshed ${latest.length} accounts (${failedCount} account(s) have auth or access issues).`, 'warning');
            } else {
              this.showToast(`All ${latest.length} account quotas refreshed successfully!`, 'success');
            }
          } catch (err: any) {
            this.showToast(`Failed to refresh all accounts: ${err.message || 'Error occurred'}`, 'error');
          }
          break;
        }
        case 'refreshAccount': {
          try {
            await this.accountService.refreshAccountQuota(data.email, true);
            const acc = this.accountService.getAccounts().find((a) => a.email.toLowerCase() === data.email.toLowerCase());
            if (!acc) {
              this.showToast(`Account ${data.email} not found.`, 'error');
            } else if (acc.status === 'auth_failed') {
              this.showToast(`Failed to refresh ${data.email}: Authentication expired. Please re-login.`, 'error');
            } else if (acc.status === 'banned' || acc.isBanned) {
              this.showToast(`Failed to refresh ${data.email}: Account is banned or disabled.`, 'error');
            } else if (acc.status === 'error') {
              this.showToast(`Failed to refresh ${data.email}: ${acc.statusMessage || 'Unknown error'}.`, 'error');
            } else {
              this.showToast(`Quota refreshed for ${data.email}.`, 'success');
            }
          } catch (err: any) {
            this.showToast(`Failed to refresh ${data.email}: ${err.message || 'Error occurred'}`, 'error');
          }
          break;
        }
        case 'addOAuth':
          await vscode.commands.executeCommand('antigravitySwap.addAccount');
          break;
        case 'importCurrentAntigravity':
          await this.accountService.importCurrentAntigravityAccount();
          break;
        case 'addManual':
          await vscode.commands.executeCommand('antigravitySwap.addAccountManual');
          break;
        case 'refreshMultipleAccounts': {
          if (Array.isArray(data.emails) && data.emails.length > 0) {
            try {
              await this.accountService.refreshMultipleAccounts(data.emails);
              const accounts = this.accountService.getAccounts().filter((a) => data.emails.includes(a.email));
              const failed = accounts.filter((a) => a.status === 'auth_failed' || a.status === 'banned');
              if (failed.length > 0) {
                this.showToast(`Refreshed ${data.emails.length} selected accounts (${failed.length} failed/expired).`, 'warning');
              } else {
                this.showToast(`Successfully refreshed ${data.emails.length} selected account(s)!`, 'success');
              }
            } catch (err: any) {
              this.showToast(`Failed to refresh selected accounts: ${err.message || 'Error occurred'}`, 'error');
            }
          }
          break;
        }
        case 'removeMultipleAccounts':
          if (Array.isArray(data.emails) && data.emails.length > 0) {
            const count = data.emails.length;
            await this.accountService.removeMultipleAccounts(data.emails, true);
            this.showToast(`Removed ${count} account${count > 1 ? 's' : ''}.`, 'info');
          }
          break;
        case 'removeAccount':
          if (data.confirmed) {
            await this.accountService.removeAccount(data.email, true);
            this.showToast(`Account ${data.email} removed.`, 'info');
          } else {
            const confirm = await vscode.window.showWarningMessage(
              `Remove account ${data.email} from Antigravity Swap?`,
              { modal: true },
              'Remove'
            );
            if (confirm === 'Remove') {
              await this.accountService.removeAccount(data.email, true);
              this.showToast(`Account ${data.email} removed.`, 'info');
            }
          }
          break;
        case 'setAutoSwitch':
          await this.accountService.setAutoSwitchEnabled(data.enabled);
          break;
        case 'setAutoSwitchTarget':
          await this.accountService.setAutoSwitchTarget(data.target);
          break;
        case 'setAutoSwitchThreshold':
          if (typeof data.threshold === 'number' && !isNaN(data.threshold)) {
            await this.accountService.setAutoSwitchThreshold(data.threshold);
          }
          break;
        case 'ready':
          this.updateWebview();
          break;
      }
    } catch (err: any) {
      console.error('[Antigravity Swap] Webview command error:', err);
      this.showToast(`Action failed: ${err.message}`, 'error');
    }
  }

  public showToast(message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    const toastMessage = {
      type: 'toast',
      message,
      level
    };
    if (this._view) {
      this._view.webview.postMessage(toastMessage);
    }
    if (this._panel) {
      this._panel.webview.postMessage(toastMessage);
    }
  }

  public updateWebview(): void {
    const accounts = this.accountService.getAccounts();
    const activeAccount = this.accountService.getActiveAccount();
    const overall = this.accountService.getOverallSummary();
    const heartbeat = this.heartbeatService.getHeartbeatInfo();

    const isLight =
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight;

    const stateMessage = {
      type: 'stateUpdate',
      accounts,
      activeAccount,
      overall,
      heartbeat,
      isBackgroundRefreshing: this.accountService.isBackgroundRefreshingState(),
      autoSwitchEnabled: this.accountService.isAutoSwitchEnabled(),
      autoSwitchTarget: this.accountService.getAutoSwitchTarget(),
      autoSwitchThreshold: this.accountService.getAutoSwitchThreshold(),
      appVersion: this.getExtensionVersion(),
      isLight
    };

    if (this._view) {
      this._view.webview.postMessage(stateMessage);
    }
    if (this._panel) {
      this._panel.webview.postMessage(stateMessage);
    }
  }

  public toggleSimulation(): void {
    const msg = { type: 'toggleSimulation' };
    if (this._view) {
      this._view.webview.postMessage(msg);
    }
    if (this._panel) {
      this._panel.webview.postMessage(msg);
    }
  }

  public sendThemeUpdate(theme?: vscode.ColorTheme): void {
    const currentTheme = theme || vscode.window.activeColorTheme;
    const isLight =
      currentTheme.kind === vscode.ColorThemeKind.Light ||
      currentTheme.kind === vscode.ColorThemeKind.HighContrastLight;
    const msg = { type: 'themeChanged', isLight };
    if (this._view) {
      this._view.webview.postMessage(msg);
    }
    if (this._panel) {
      this._panel.webview.postMessage(msg);
    }
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'dist', 'webview', 'index.html');

    if (!fs.existsSync(htmlPath)) {
      return `<!DOCTYPE html><html lang="en" class="dark"><head><meta charset="UTF-8"><title>Antigravity Swap</title></head>
<body style="padding:16px;color:#f87171;font-family:sans-serif;">
  <h3>Webview bundle not found</h3>
  <p>Run <code>npm run build</code> to build the webview.</p>
</body></html>`;
    }
    const template = fs.readFileSync(htmlPath, 'utf8');

    const nonce = this.getNonce();
    let html = template;

    // Inject initial snapshot data directly into root attribute for instant 0ms first frame render
    try {
      const accounts = this.accountService.getAccounts();
      const activeAccount = this.accountService.getActiveAccount();
      const overall = this.accountService.getOverallSummary();
      const heartbeat = this.heartbeatService.getHeartbeatInfo();
      const isLight =
        vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
        vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight;

      const initialState = {
        accounts,
        activeAccount,
        overall,
        heartbeat,
        autoSwitchEnabled: this.accountService.isAutoSwitchEnabled(),
        autoSwitchTarget: this.accountService.getAutoSwitchTarget(),
        autoSwitchThreshold: this.accountService.getAutoSwitchThreshold(),
        appVersion: this.getExtensionVersion(),
        isLight
      };
      const b64State = Buffer.from(JSON.stringify(initialState)).toString('base64');
      html = html.replace('<div id="root"></div>', `<div id="root" data-initial-state="${b64State}"></div>`);
    } catch (e) {
      console.warn('[Antigravity Swap] Could not inject initial state into HTML:', e);
    }

    // viteSingleFile inlines everything as <script type="module" crossorigin>...</script>
    // IMPORTANT: Use non-global replace (no /g flag) to only inject nonce onto the FIRST
    // real script tag. A global replace also hits <script> string literals embedded inside
    // React DOM's minified code (e.g. innerHTML XSS-safety strings), corrupting the bundle.
    html = html.replace(/<script(\b[^>]*)>/, (_match, attrs) => {
      return `<script${attrs} nonce="${nonce}">`;
    });

    // Inject CSP - for inline module scripts, 'nonce-xxx' in script-src is what enables them
    const csp = [
      `default-src 'none'`,
      `style-src 'unsafe-inline'`,
      `img-src ${webview.cspSource} https: data: blob:`,
      `font-src 'unsafe-inline' data:`,
      `script-src 'nonce-${nonce}' 'unsafe-eval'`,
    ].join('; ');

    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
    html = html.replace('<head>', `<head>\n  ${cspMeta}`);

    return html;
  }

  private getExtensionVersion(): string {
    try {
      const pkgPath = path.join(this.extensionUri.fsPath, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg && pkg.version) {
          return `v${pkg.version}`;
        }
      }
    } catch {}
    return '';
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
