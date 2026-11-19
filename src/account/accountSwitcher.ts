import * as vscode from 'vscode';
import { AccountInfo, OAuthTokens } from '../types';
import { StorageService } from '../storage';
import { OAuthService } from '../auth';
import { EXTENSION_DEFAULTS } from '../constants';

export interface AccountSwitcherContext {
  getAccounts: () => AccountInfo[];
  setAccounts: (accounts: AccountInfo[]) => void;
  getActiveEmail: () => string | undefined;
  setActiveEmail: (email: string | undefined) => void;
  notifyStateChange: () => void;
  onPostSwitch?: (email: string) => void;
}

/**
 * AccountSwitcher
 * Handles switching active accounts, including token refresh validation,
 * in-memory USS hot-switching, SQLite state synchronization, and language server restarts.
 */
export class AccountSwitcher {
  private isSwitching = false;
  private lastSwitchTime = 0;
  private static readonly SWITCH_COOLDOWN_MS = EXTENSION_DEFAULTS.SWITCH_COOLDOWN_MS;

  constructor(
    private readonly storage: StorageService,
    private readonly oauthService: OAuthService,
    private readonly ctx: AccountSwitcherContext
  ) {}

  public isSwitchInProgress(): boolean {
    return this.isSwitching;
  }

  /**
   * Switches to the given account and relaunches Antigravity IDE with the new account loaded into memory.
   * @param email Target account email.
   * @param isManual Set to true when the user explicitly pressed "Switch" — this disables auto-switch.
   * @param isSilent Set to true when called from Webview UI to suppress native VS Code notifications.
   */
  public async switchAccount(email: string, isManual = false, isSilent = false): Promise<boolean> {
    const now = Date.now();
    if (this.isSwitching || now - this.lastSwitchTime < AccountSwitcher.SWITCH_COOLDOWN_MS) {
      console.log('[Antigravity Swap] Switch rate-limited / cooldown active. Ignored.');
      return false;
    }

    if (this.ctx.getActiveEmail() === email) {
      return true;
    }

    this.isSwitching = true;
    this.lastSwitchTime = now;

    try {
      const accounts = this.ctx.getAccounts();
      const target = accounts.find((a) => a.email === email);
      if (!target) {
        if (!isSilent) {
          vscode.window.showErrorMessage(`Account ${email} not found in Antigravity Swap.`);
        }
        return false;
      }

      if (target.isBanned || target.status === 'banned') {
        if (!isSilent) {
          vscode.window.showErrorMessage(`Cannot switch: Account ${email} is banned or suspended by Google Terms of Service.`);
        }
        return false;
      }

      if (target.status === 'auth_failed') {
        return false;
      }

      let tokens = await this.storage.getAccountTokens(email);
      if (!tokens || !tokens.accessToken) {
        target.status = 'auth_failed';
        target.statusMessage = 'Credentials missing. Re-login required.';
        await this.storage.saveAccounts(accounts);
        this.ctx.notifyStateChange();
        return false;
      }

      // Check if access token is expired or expiring within 2 minutes and refresh
      if (tokens.expiresAt && Date.now() > tokens.expiresAt - 120000 && tokens.refreshToken) {
        this.storage.renewRefreshLease();
        try {
          tokens = await this.oauthService.refreshAccessToken(tokens.refreshToken);
          await this.storage.saveAccountTokens(email, tokens);
          this.storage.renewRefreshLease();
        } catch (err: any) {
          console.warn(`[Antigravity Swap] Token refresh failed before switch: ${err.message}`);
          this.storage.renewRefreshLease();
          const msg = err.message || '';
          const isAuthError = msg.includes('AUTH_EXPIRED') || msg.includes('invalid_grant') || msg.includes('400') || msg.includes('401');
          if (isAuthError) {
            target.status = 'auth_failed';
            target.statusMessage = 'Credentials expired. Re-login required.';
          } else {
            // Transient or network error: retain health status so account can self-heal on next heartbeat/refresh
            target.statusMessage = `Switch failed: ${msg || 'Network error'}`;
          }
          await this.storage.saveAccounts(accounts);
          this.ctx.notifyStateChange();
          return false;
        }
      } else if (tokens.expiresAt && Date.now() > tokens.expiresAt && !tokens.refreshToken) {
        // Access token expired and no refresh token available
        target.status = 'auth_failed';
        target.statusMessage = 'Session expired. Re-login required.';
        await this.storage.saveAccounts(accounts);
        this.ctx.notifyStateChange();
        return false;
      }

      // Pre-flight check: Dynamic scope verification against required IDE scopes.
      // Antigravity IDE requires all scopes in OAUTH_CONFIG.SCOPES (e.g. aicode, cloud-platform).
      // If a token lacks any required scope, agy signs out the user immediately, wiping IDE sessions.
      let hasRequiredScopes = tokens.hasRequiredScopes;
      let missingScopes = tokens.missingScopes;

      if (hasRequiredScopes === undefined && tokens.accessToken) {
        try {
          const scopeInfo = await this.oauthService.verifyTokenScopes(tokens.accessToken);
          hasRequiredScopes = scopeInfo.hasRequiredScopes;
          missingScopes = scopeInfo.missingScopes;
          tokens.scopes = scopeInfo.scopes;
          tokens.missingScopes = scopeInfo.missingScopes;
          tokens.hasRequiredScopes = scopeInfo.hasRequiredScopes;
          tokens.hasAiCode = scopeInfo.hasAiCode;
          await this.storage.saveAccountTokens(email, tokens);
        } catch {
          // If network check fails, fallback to allowing switch so offline/intranet usage is not blocked
          hasRequiredScopes = tokens.hasAiCode !== false;
        }
      }

      if (hasRequiredScopes === false || tokens.hasAiCode === false) {
        target.status = 'auth_failed';
        target.needsReauth = true;
        target.missingScopes = missingScopes;
        target.hasRequiredScopes = false;
        target.statusMessage = 'Re-authorization required. Please sign in again.';
        await this.storage.saveAccounts(accounts);
        this.ctx.notifyStateChange();

        if (!isSilent) {
          vscode.window.showWarningMessage(
            `Account ${email} requires re-authorization. Please sign in again to enable switching.`,
            'Re-login Account'
          ).then((action) => {
            if (action === 'Re-login Account') {
              vscode.commands.executeCommand('antigravitySwap.reloginAccount', email);
            }
          });
        }
        return false;
      }

      // 1. If the user manually chose this account, disable auto-switch so it won't override their choice
      if (isManual) {
        await this.storage.setAutoSwitchEnabled(false);
      }

      // 2. Update IDE state database (state.vscdb) and cloud agent DB in-place FIRST
      // so disk records and storage entries have the target email ready before any reconnect
      await this.storage.syncToIdeStateDb(target, tokens, false);
      await this.storage.syncToCloudAccountsDb(email);

      // 3. Update google_accounts.json so active email is aligned
      await this.storage.syncGoogleAccountsJson(email);

      // 4. Hot-switch in-memory via Unified State Sync API so language server and agent immediately get the new token!
      await this.storage.liveSwitchOAuthToken(target, tokens, false, true, true);

      // 5. Broadcast switch event to all other open IDE instances
      this.storage.broadcastSwitchCompleted(email);

      // 6. ONLY AFTER all operations succeed without error, update internal state and active card!
      // This guarantees the card does NOT sort prematurely and only updates to the top on true success.
      const updatedAccounts = accounts.map((a) => ({
        ...a,
        isActive: a.email === email,
        lastUsedAt: a.email === email ? new Date().toISOString() : a.lastUsedAt
      }));
      this.ctx.setAccounts(updatedAccounts);
      this.ctx.setActiveEmail(email);
      await this.storage.saveAccounts(updatedAccounts);
      await this.storage.setActiveAccountEmail(email);
      this.ctx.notifyStateChange();

      if (this.ctx.onPostSwitch) {
        this.ctx.onPostSwitch(email);
      }

      if (!isSilent) {
        vscode.window.showInformationMessage(`Switched to: ${target.name || email}!`);
      }
      return true;
    } catch (unhandledErr: any) {
      console.error(`[Antigravity Swap] Unexpected error switching to ${email}:`, unhandledErr);
      const accounts = this.ctx.getAccounts();
      const target = accounts.find((a) => a.email === email);
      if (target) {
        target.statusMessage = `Switch failed: ${unhandledErr?.message || 'Unknown error'}`;
        await this.storage.saveAccounts(accounts).catch(() => {});
        this.ctx.notifyStateChange();
      }
      return false;
    } finally {
      this.isSwitching = false;
    }
  }
}
