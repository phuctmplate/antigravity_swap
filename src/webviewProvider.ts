import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AccountManager } from './accountManager';
import { HeartbeatService } from './heartbeatService';

export class WebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'antigravitySwap.dashboardView';
  private _view?: vscode.WebviewView;
  private _panel?: vscode.WebviewPanel;

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

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.accountManager.syncCurrentAccountFromIde().catch(() => {});
        this.updateWebview();
      }
    });

    this.accountManager.syncCurrentAccountFromIde().then(() => this.updateWebview());

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
        case 'switchAccount':
          await this.accountManager.switchAccount(data.email, data.isManual === true);
          break;
        case 'relogin':
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
        case 'refreshMultipleAccounts':
          if (Array.isArray(data.emails) && data.emails.length > 0) {
            await this.accountManager.refreshMultipleAccounts(data.emails);
          }
          break;
        case 'removeMultipleAccounts':
          if (Array.isArray(data.emails) && data.emails.length > 0) {
            await this.accountManager.removeMultipleAccounts(data.emails);
          }
          break;
        case 'removeAccount':
          if (data.confirmed) {
            await this.accountManager.removeAccount(data.email);
          } else {
            const confirm = await vscode.window.showWarningMessage(
              `Remove account ${data.email} from Antigravity Swap?`,
              { modal: true },
              'Remove'
            );
            if (confirm === 'Remove') {
              await this.accountManager.removeAccount(data.email);
            }
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
  }

  public updateWebview(): void {
    const accounts = this.accountManager.getAccounts();
    const activeAccount = this.accountManager.getActiveAccount();
    const overall = this.accountManager.getOverallSummary();
    const heartbeat = this.heartbeatService.getHeartbeatInfo();

    const stateMessage = {
      type: 'stateUpdate',
      accounts,
      activeAccount,
      overall,
      heartbeat,
      autoSwitchEnabled: this.accountManager.isAutoSwitchEnabled()
    };

    if (this._view) {
      this._view.webview.postMessage(stateMessage);
    }
    if (this._panel) {
      this._panel.webview.postMessage(stateMessage);
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

    const nonce = this.getNonce();
    let html = fs.readFileSync(htmlPath, 'utf8');

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

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
