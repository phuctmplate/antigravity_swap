import * as vscode from 'vscode';
import { StorageService } from './storage';
import { OAuthService } from './oauthService';
import { QuotaService } from './quotaService';
import { AccountManager } from './accountManager';
import { StatusBarService } from './statusBar';
import { WebviewProvider } from './webviewProvider';

let refreshTimer: NodeJS.Timeout | undefined;

export async function activate(context: vscode.ExtensionContext) {
  console.log('[Antigravity Swap] Activating extension...');

  const storageService = new StorageService(context, context.secrets);
  const oauthService = new OAuthService();
  const quotaService = new QuotaService(oauthService);
  const accountManager = new AccountManager(storageService, oauthService, quotaService);

  // Initialize accounts and discovery
  await accountManager.initialize();

  // Register Webview Sidebar Provider
  const webviewProvider = new WebviewProvider(context.extensionUri, accountManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WebviewProvider.viewType, webviewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Register Status Bar
  const statusBar = new StatusBarService(accountManager);
  context.subscriptions.push(statusBar);

  // Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravitySwap.openQuickMenu', async () => {
      await statusBar.showQuickMenu();
    }),

    vscode.commands.registerCommand('antigravitySwap.switchAccount', async (emailArg?: string) => {
      if (emailArg && typeof emailArg === 'string') {
        await accountManager.switchAccount(emailArg);
        return;
      }

      const accounts = accountManager.getAccounts();
      if (accounts.length === 0) {
        const addChoice = await vscode.window.showInformationMessage(
          'No accounts in Antigravity Swap. Add your first account now?',
          'Sign in with Google',
          'Cancel'
        );
        if (addChoice === 'Sign in with Google') {
          await accountManager.addAccountViaOAuth();
        }
        return;
      }

      const items = accounts.map((a) => ({
        label: `${a.isActive ? '$(check) ' : ''}${a.name || a.email}`,
        description: `${a.email} (${a.averageQuotaPercentage}% quota left)`,
        email: a.email
      }));

      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select account to switch without reload'
      });

      if (pick) {
        await accountManager.switchAccount(pick.email);
      }
    }),

    vscode.commands.registerCommand('antigravitySwap.addAccount', async () => {
      await accountManager.addAccountViaOAuth();
    }),

    vscode.commands.registerCommand('antigravitySwap.addAccountManual', async () => {
      const email = await vscode.window.showInputBox({
        title: 'Add Account Manually (Step 1/3)',
        prompt: 'Enter Google account email address',
        placeHolder: 'user@example.com',
        ignoreFocusOut: true
      });
      if (!email) return;

      const accessToken = await vscode.window.showInputBox({
        title: 'Add Account Manually (Step 2/3)',
        prompt: 'Enter OAuth Access Token (ya29...)',
        placeHolder: 'ya29.a0...',
        password: true,
        ignoreFocusOut: true
      });
      if (!accessToken) return;

      const refreshToken = await vscode.window.showInputBox({
        title: 'Add Account Manually (Step 3/3 - Optional)',
        prompt: 'Enter Refresh Token (1//...) for auto-renewal (optional)',
        placeHolder: '1//0g...',
        password: true,
        ignoreFocusOut: true
      });

      const name = await vscode.window.showInputBox({
        title: 'Account Nickname (Optional)',
        prompt: 'Enter display name / alias for this account',
        placeHolder: email.split('@')[0],
        ignoreFocusOut: true
      });

      await accountManager.addAccountManually(email, accessToken, refreshToken, name);
    }),

    vscode.commands.registerCommand('antigravitySwap.removeAccount', async (emailArg?: string) => {
      let email = emailArg;
      if (!email) {
        const accounts = accountManager.getAccounts();
        const pick = await vscode.window.showQuickPick(
          accounts.map((a) => ({ label: a.email, description: a.name })),
          { placeHolder: 'Select account to remove' }
        );
        if (!pick) return;
        email = pick.label;
      }
      await accountManager.removeAccount(email);
    }),

    vscode.commands.registerCommand('antigravitySwap.refreshQuotas', async () => {
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Refreshing all Antigravity account quotas...',
          cancellable: false
        },
        async () => {
          await accountManager.refreshAllQuotas();
          vscode.window.showInformationMessage('⚡ Quotas updated successfully!');
        }
      );
    }),

    vscode.commands.registerCommand('antigravitySwap.importExistingAccounts', async () => {
      const count = await accountManager.importDetectedAccounts();
      if (count > 0) {
        vscode.window.showInformationMessage(`Imported ${count} previously active account(s)!`);
      } else {
        vscode.window.showInformationMessage('No new accounts detected on local machine.');
      }
    }),

    vscode.commands.registerCommand('antigravitySwap.openDashboard', async () => {
      await vscode.commands.executeCommand('antigravitySwap.dashboardView.focus');
    })
  );

  // Setup periodic background refresh
  const config = vscode.workspace.getConfiguration('antigravitySwap');
  const intervalMinutes = config.get<number>('autoRefreshIntervalMinutes', 3);
  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;

  refreshTimer = setInterval(() => {
    accountManager.refreshAllQuotas().catch((err) => {
      console.warn('[Antigravity Swap] Background quota refresh error:', err);
    });
  }, intervalMs);

  context.subscriptions.push({
    dispose: () => {
      if (refreshTimer) {
        clearInterval(refreshTimer);
      }
    }
  });

  console.log('[Antigravity Swap] Extension active!');
}

export function deactivate() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
}
