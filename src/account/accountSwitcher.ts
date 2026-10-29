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

      // Check if access token is expired and refresh
      if (tokens.expiresAt && Date.now() > tokens.expiresAt - 60000 && tokens.refreshToken) {
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

      const previousEmail = this.ctx.getActiveEmail() || accounts.find((a) => a.isActive)?.email;

      // 1. Update internal state
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

      // 2. If the user manually chose this account, disable auto-switch so it won't override their choice
      if (isManual) {
        await this.storage.setAutoSwitchEnabled(false);
      }

      // 3. Update google_accounts.json FIRST so the new active email and old list are in place for eviction
      await this.storage.syncGoogleAccountsJson(email);

      // 4. Hot-switch in-memory via Unified State Sync API so language server and agent immediately get the new token!
      const liveSwitchOk = await this.storage.liveSwitchOAuthToken(target, tokens);

      // 5. Explicitly evict previous sessions via antigravity.evictAuthSession if available
      if (previousEmail && previousEmail !== email) {
        try {
          await vscode.commands.executeCommand('antigravity.evictAuthSession', previousEmail);
        } catch (_) {}
      }
      for (const a of updatedAccounts) {
        if (a.email !== email) {
          try {
            await vscode.commands.executeCommand('antigravity.evictAuthSession', a.email);
          } catch (_) {}
        }
      }

      // 6. Update IDE state database (state.vscdb) and cloud agent DB in-place
      await this.storage.syncToIdeStateDb(target, tokens, liveSwitchOk);
      await this.storage.syncToCloudAccountsDb(email);

      // 7. Hot-restart the Antigravity Language Server in the background so it immediately picks up new credentials without closing IDE
      try {
        await vscode.commands.executeCommand('antigravity.handleAuthRefresh');
      } catch (_) {}
      try {
        await vscode.commands.executeCommand('antigravity.restartLanguageServer');
        console.log('[Antigravity Swap] Executed antigravity.restartLanguageServer successfully');
      } catch (lsErr: any) {
        console.warn('[Antigravity Swap] restartLanguageServer command warning:', lsErr?.message || lsErr);
      }

      // 8. Post-Switch Active Account Verification Guard:
      // Verify whether the Antigravity IDE / credential manager actually switched to the target account.
      // If the IDE remained on previousEmail, roll back internal state and report failure so caller can try next candidate.
      if (previousEmail && previousEmail.toLowerCase() !== email.toLowerCase()) {
        await new Promise((r) => setTimeout(r, 600));
        const verification = await this.storage.verifyIdeActiveAccount(email);
        if (!verification.verified && verification.actualEmail && verification.actualEmail.toLowerCase() === previousEmail.toLowerCase()) {
          console.warn(`[AccountSwitcher] Switch verification failed: IDE remained on ${previousEmail} instead of switching to ${email}. Rolling back.`);

          // Rollback internal active account to previousEmail
          const rolledBackAccounts = accounts.map((a) => ({
            ...a,
            isActive: a.email.toLowerCase() === previousEmail.toLowerCase(),
            statusMessage: a.email === email ? 'Switch failed: IDE remained on previous account' : a.statusMessage
          }));
          this.ctx.setAccounts(rolledBackAccounts);
          this.ctx.setActiveEmail(previousEmail);
          await this.storage.saveAccounts(rolledBackAccounts);
          await this.storage.setActiveAccountEmail(previousEmail);
          await this.storage.syncGoogleAccountsJson(previousEmail);
          this.ctx.notifyStateChange();

          // Reset lastSwitchTime so immediate retry on next candidate is not rate-limited
          this.lastSwitchTime = 0;

          if (!isSilent) {
            vscode.window.showErrorMessage(`Switch to ${email} failed: IDE remained on ${previousEmail}. Rollback complete.`);
          }
          return false;
        }
      }

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
