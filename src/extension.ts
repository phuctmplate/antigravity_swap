import * as vscode from 'vscode';
import { StorageService } from './storage';
import { OAuthService } from './oauthService';
import { QuotaService } from './quotaService';
import { AccountManager } from './accountManager';
import { StatusBarService } from './statusBar';
import { WebviewProvider } from './webviewProvider';
import { HeartbeatService } from './heartbeatService';
import { CONFIG_KEYS, EXTENSION_DEFAULTS } from './constants';
import { ensureIdeExtensionPatched, restoreIdeExtensionBackup } from './patchIdeExtension';

export async function activate(context: vscode.ExtensionContext) {
  console.log('[Antigravity Swap] Activating extension with Heartbeat & Ban detection...');

  // Check if IDE extension patch is enabled in background (non-blocking)
  const config = vscode.workspace.getConfiguration(CONFIG_KEYS.SECTION);
  const patchEnabled = config.get<boolean>(CONFIG_KEYS.ENABLE_IDE_PATCH, true);
  if (patchEnabled) {
    setTimeout(() => {
      try {
        ensureIdeExtensionPatched();
      } catch (patchErr) {
        console.warn('[Antigravity Swap] Error ensuring IDE extension patched:', patchErr);
      }
    }, 100);
  }

  const storageService = new StorageService(context, context.secrets);
  const oauthService = new OAuthService();
  const quotaService = new QuotaService(oauthService);
  const accountManager = new AccountManager(storageService, oauthService, quotaService);
  const heartbeatService = new HeartbeatService(accountManager);

  // Register Webview Sidebar Provider immediately (synchronous to prevent ServiceWorker invalid state)
  const webviewProvider = new WebviewProvider(context.extensionUri, accountManager, heartbeatService);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WebviewProvider.viewType, webviewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Initialize accounts in background without blocking webview registration
  accountManager.initialize().catch((err) => {
    console.error('[Antigravity Swap] AccountManager initialization error:', err);
  });

  // Listen for IDE auth session changes (login / logout / account switch directly in IDE)
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions(async (e) => {
      console.log(`[Antigravity Swap] Auth session changed for provider: ${e.provider.id}`);
      if (
        e.provider.id === 'antigravity_auth' ||
        e.provider.id.includes('antigravity') ||
        e.provider.id === 'google'
      ) {
        await accountManager.handleIdeSessionChange();
      }
    })
  );

  // Start Heartbeat service
  const heartbeatSec = config.get<number>(CONFIG_KEYS.HEARTBEAT_INTERVAL, EXTENSION_DEFAULTS.DEFAULT_HEARTBEAT_SECONDS);
  heartbeatService.start(heartbeatSec);
  context.subscriptions.push(heartbeatService);

  // Register Status Bar
  const statusBar = new StatusBarService(accountManager);
  context.subscriptions.push(statusBar);

  // Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravitySwap.restoreOriginalIdeExtension', async () => {
      const ok = restoreIdeExtensionBackup();
      if (ok) {
        // Disable auto-patching so it won't be re-applied automatically on next launch
        await vscode.workspace.getConfiguration(CONFIG_KEYS.SECTION).update(CONFIG_KEYS.ENABLE_IDE_PATCH, false, vscode.ConfigurationTarget.Global);
        const choice = await vscode.window.showInformationMessage(
          'Original Antigravity extension restored from backup. Auto-patching has been disabled. Please reload the window to apply.',
          'Reload Window'
        );
        if (choice === 'Reload Window') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } else {
        vscode.window.showErrorMessage('Failed to restore backup: extension.js.bak not found or invalid.');
      }
    }),

    vscode.commands.registerCommand('antigravitySwap.enableIdeExtensionPatch', async () => {
      await vscode.workspace.getConfiguration(CONFIG_KEYS.SECTION).update(CONFIG_KEYS.ENABLE_IDE_PATCH, true, vscode.ConfigurationTarget.Global);
      const ok = ensureIdeExtensionPatched();
      if (ok) {
        const choice = await vscode.window.showInformationMessage(
          'Antigravity IDE extension patch enabled and applied. Please reload the window to activate zero-reload account switching.',
          'Reload Window'
        );
        if (choice === 'Reload Window') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } else {
        vscode.window.showErrorMessage('Failed to apply IDE extension patch.');
      }
    }),

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

      const items = accounts.map((a) => {
        let statusBadge = '';
        if (a.isBanned) statusBadge = ' [⛔ BANNED]';
        else if (a.status === 'auth_failed') statusBadge = ' [⚠️ AUTH FAILED]';

        return {
          label: `${a.isActive ? '$(check) ' : ''}${a.name || a.email}${statusBadge}`,
          description: `${a.email} (${a.averageQuotaPercentage}% quota left)`,
          email: a.email
        };
      });

      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select account to switch without reload'
      });

      if (pick) {
        await accountManager.switchAccount(pick.email);
      }
    }),

    vscode.commands.registerCommand('antigravitySwap.reloginAccount', async (emailArg?: string) => {
      let email = emailArg;
      if (!email) {
        const accounts = accountManager.getAccounts();
        const pick = await vscode.window.showQuickPick(
          accounts.map((a) => ({
            label: `${a.isBanned ? '⛔ ' : ''}${a.email}`,
            description: a.statusMessage || a.name,
            email: a.email
          })),
          { placeHolder: 'Select account to re-authenticate' }
        );
        if (!pick) return;
        email = pick.email;
      }
      await accountManager.reloginAccount(email);
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
          title: 'Heartbeat: Refreshing all Antigravity account quotas...',
          cancellable: false
        },
        async () => {
          await heartbeatService.tick();
          vscode.window.showInformationMessage('⚡ Heartbeat quota check completed!');
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

    vscode.commands.registerCommand('antigravitySwap.importCurrentAntigravity', async () => {
      await accountManager.importCurrentAntigravityAccount();
    }),

    vscode.commands.registerCommand('antigravitySwap.popOutDashboard', () => {
      webviewProvider.openDetachedPanel();
    }),

    vscode.commands.registerCommand('antigravitySwap.openDashboard', () => {
      webviewProvider.openDetachedPanel();
    })
  );

  console.log('[Antigravity Swap] Extension initialized with Heartbeat.');
}

export function deactivate() {}
