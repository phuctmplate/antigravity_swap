import * as vscode from 'vscode';
import { AccountInfo, OAuthTokens } from '../types';
import { StorageService } from '../storage';
import { OAuthService } from '../auth';
import { EXTENSION_DEFAULTS } from '../constants';
import { clearSharedIdeQuotaCache } from '../quota';

export interface AccountSwitcherContext {
  getAccounts: () => AccountInfo[];
  setAccounts: (accounts: AccountInfo[]) => void;
  getActiveEmail: () => string | undefined;
  setActiveEmail: (email: string | undefined) => void;
  setIdeSessionEmail?: (email: string | undefined) => void;
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
  private switchingEmail: string | undefined = undefined;
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

  public getSwitchingEmail(): string | undefined {
    return this.switchingEmail;
  }

  /**
   * Verifies that Antigravity IDE accepted the switched account session instead of rejecting it and signing out.
   */
  private async verifyIdeAcceptedSession(
    expectedEmail: string
  ): Promise<{ accepted: boolean; reason?: string; observedIdeEmail?: string }> {
    if (typeof this.storage.getLiveIdeAuthState !== 'function') {
      return { accepted: true, observedIdeEmail: expectedEmail.trim().toLowerCase() };
    }

    const expectedLower = expectedEmail.trim().toLowerCase();
    const pollDelayMs = 500;
    const maxPolls = 6;
    let lastLiveState: { authState: 'signedIn' | 'signedOut' | 'unknown'; email?: string; rejectionMessage?: string } = {
      authState: 'unknown'
    };

    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, pollDelayMs));
      let liveState: { authState: 'signedIn' | 'signedOut' | 'unknown'; email?: string; rejectionMessage?: string };
      try {
        liveState = await this.storage.getLiveIdeAuthState({
          skipDiskFallback: true,
          forceServerRefresh: i === 0 || i === 3
        });
      } catch {
        continue;
      }

      lastLiveState = liveState;

      if (liveState.authState === 'signedOut') {
        // Confirm once after a brief settle so transient state transitions aren't misread
        await new Promise((r) => setTimeout(r, 300));
        try {
          const confirmState = await this.storage.getLiveIdeAuthState({
            skipDiskFallback: true,
            forceServerRefresh: false
          });
          if (confirmState.authState === 'signedOut') {
            return {
              accepted: false,
              reason:
                confirmState.rejectionMessage ||
                liveState.rejectionMessage ||
                'IDE rejected account session and requested Google sign-in. Click Re-login to verify.',
              observedIdeEmail: undefined
            };
          }
          liveState = confirmState;
          lastLiveState = confirmState;
        } catch {
          return {
            accepted: false,
            reason:
              liveState.rejectionMessage ||
              'IDE rejected account session and requested Google sign-in. Click Re-login to verify.',
            observedIdeEmail: undefined
          };
        }
      }

      if (liveState.authState === 'signedIn' && liveState.email) {
        const actualLower = liveState.email.trim().toLowerCase();
        if (actualLower === expectedLower) {
          // Wait once briefly to catch delayed sign-outs (e.g. async validation or scope rejection)
          await new Promise((r) => setTimeout(r, 400));
          try {
            const settleState = await this.storage.getLiveIdeAuthState({
              skipDiskFallback: true,
              forceServerRefresh: false
            });
            if (settleState.authState === 'signedOut') {
              return {
                accepted: false,
                reason:
                  settleState.rejectionMessage ||
                  'IDE rejected account session and requested Google sign-in. Click Re-login to verify.',
                observedIdeEmail: undefined
              };
            }
            if (settleState.authState === 'signedIn' && settleState.email) {
              const settledLower = settleState.email.trim().toLowerCase();
              if (settledLower !== expectedLower) {
                return {
                  accepted: false,
                  reason: `IDE did not retain switched session (active in IDE: ${settleState.email}). Click Re-login to verify.`,
                  observedIdeEmail: settledLower
                };
              }
            }
          } catch {}
          return { accepted: true, observedIdeEmail: expectedLower };
        }

        if (i >= 3) {
          return {
            accepted: false,
            reason: `IDE did not apply switched session (active in IDE: ${liveState.email}). Click Re-login to verify.`,
            observedIdeEmail: actualLower
          };
        }
      }
    }

    if (lastLiveState.authState === 'signedIn' && lastLiveState.email) {
      const actualLower = lastLiveState.email.trim().toLowerCase();
      if (actualLower !== expectedLower) {
        return {
          accepted: false,
          reason: `IDE did not apply switched session (active in IDE: ${lastLiveState.email}). Click Re-login to verify.`,
          observedIdeEmail: actualLower
        };
      }
    }

    return { accepted: true, observedIdeEmail: expectedLower };
  }

  private async markAccountNotVerified(
    accounts: AccountInfo[],
    target: AccountInfo,
    tokens: OAuthTokens | undefined,
    message: string,
    isSilent: boolean,
    missingScopes?: string[],
    releaseActive = false
  ): Promise<void> {
    target.status = 'auth_failed';
    target.needsReauth = true;
    target.hasRequiredScopes = false;
    if (missingScopes) {
      target.missingScopes = missingScopes;
    }
    target.statusMessage = message;
    if (releaseActive) {
      target.isActive = false;
    }

    if (tokens) {
      tokens.hasRequiredScopes = false;
      if (missingScopes) {
        tokens.missingScopes = missingScopes;
      }
      await this.storage.saveAccountTokens(target.email, tokens).catch(() => {});
    }

    const updatedAccounts = releaseActive
      ? accounts.map((a) => (a.email === target.email ? target : { ...a, isActive: false }))
      : accounts.map((a) => (a.email === target.email ? target : a));

    this.ctx.setAccounts(updatedAccounts);
    if (releaseActive) {
      this.ctx.setActiveEmail(undefined);
      await this.storage.setActiveAccountEmail(undefined);
    }
    await this.storage.saveAccounts(updatedAccounts);
    this.ctx.notifyStateChange();

    if (!isSilent) {
      vscode.window.showWarningMessage(
        `Account ${target.email} is not verified: ${message}`,
        'Re-login Account'
      ).then((action) => {
        if (action === 'Re-login Account') {
          vscode.commands.executeCommand('antigravitySwap.reloginAccount', target.email);
        }
      });
    }
  }

  /**
   * Switches to the given account and relaunches Antigravity IDE with the new account loaded into memory.
   * @param email Target account email.
   * @param isManual Set to true when the user explicitly pressed "Switch" — this disables auto-switch.
   * @param isSilent Set to true when called from Webview UI to suppress native VS Code notifications.
   * @param force Re-pushes credentials to IDE even if this account is already active.
   */
  public async switchAccount(email: string, isManual = false, isSilent = false, force = false): Promise<boolean> {
    const now = Date.now();
    if (this.isSwitching) {
      console.log('[Antigravity Swap] Switch already in progress. Ignored.');
      return false;
    }

    if (!force && now - this.lastSwitchTime < AccountSwitcher.SWITCH_COOLDOWN_MS) {
      console.log('[Antigravity Swap] Switch rate-limited / cooldown active. Ignored.');
      return false;
    }

    if (!force && this.ctx.getActiveEmail() === email) {
      return true;
    }

    this.isSwitching = true;

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

      if (target.status === 'auth_failed' || target.needsReauth) {
        return false;
      }

      this.switchingEmail = email;
      this.ctx.notifyStateChange();

      let tokens = await this.storage.getAccountTokens(email);
      if (!tokens || !tokens.accessToken) {
        await this.markAccountNotVerified(
          accounts,
          target,
          tokens ?? undefined,
          'Credentials missing. Click Re-login to verify.',
          isSilent,
          undefined,
          false
        );
        return false;
      }

      // Refresh access token if missing expiry, expired, or expiring within 2 minutes
      if ((!tokens.expiresAt || Date.now() > tokens.expiresAt - 120000) && tokens.refreshToken) {
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
            await this.markAccountNotVerified(
              accounts,
              target,
              tokens,
              'Credentials expired. Click Re-login to verify.',
              isSilent,
              undefined,
              false
            );
          } else {
            // Transient or network error: retain health status so account can self-heal on next heartbeat/refresh
            target.statusMessage = `Switch failed: ${msg || 'Network error'}`;
            await this.storage.saveAccounts(accounts);
            this.ctx.notifyStateChange();
          }
          return false;
        }
      } else if (tokens.expiresAt && Date.now() > tokens.expiresAt && !tokens.refreshToken) {
        // Access token expired and no refresh token available
        await this.markAccountNotVerified(
          accounts,
          target,
          tokens,
          'Session expired. Click Re-login to verify.',
          isSilent,
          undefined,
          false
        );
        return false;
      }

      // Pre-flight check: Live token & scope verification (do not trust stale cached hasRequiredScopes=true alone).
      let hasRequiredScopes: boolean | undefined = tokens.hasRequiredScopes;
      let missingScopes = tokens.missingScopes;
      let tokenConfirmedRevoked = false;

      if (tokens.accessToken && typeof this.oauthService.verifyTokenScopes === 'function') {
        try {
          let scopeInfo = await this.oauthService.verifyTokenScopes(tokens.accessToken);
          if (!scopeInfo.valid && tokens.refreshToken) {
            try {
              this.storage.renewRefreshLease();
              tokens = await this.oauthService.refreshAccessToken(tokens.refreshToken);
              await this.storage.saveAccountTokens(email, tokens);
              scopeInfo = await this.oauthService.verifyTokenScopes(tokens.accessToken);
            } catch (refreshErr: any) {
              const refreshMsg = refreshErr?.message || '';
              if (
                refreshMsg.includes('AUTH_EXPIRED') ||
                refreshMsg.includes('invalid_grant') ||
                refreshMsg.includes('400') ||
                refreshMsg.includes('401')
              ) {
                tokenConfirmedRevoked = true;
              }
            }
          } else if (!scopeInfo.valid && !tokens.refreshToken) {
            tokenConfirmedRevoked = true;
          }

          if (scopeInfo.valid) {
            hasRequiredScopes = scopeInfo.hasRequiredScopes;
            missingScopes = scopeInfo.missingScopes;
            tokens.scopes = scopeInfo.scopes;
            tokens.missingScopes = scopeInfo.missingScopes;
            tokens.hasRequiredScopes = scopeInfo.hasRequiredScopes;
            tokens.hasAiCode = scopeInfo.hasAiCode;
            await this.storage.saveAccountTokens(email, tokens);
          } else {
            hasRequiredScopes = false;
            missingScopes = scopeInfo.missingScopes;
            tokenConfirmedRevoked = true;
          }
        } catch {
          // If network check fails, fallback to cached/allowing switch so offline usage is not blocked
          if (hasRequiredScopes === undefined) {
            hasRequiredScopes = true;
          }
        }
      }

      if (hasRequiredScopes === false || tokenConfirmedRevoked) {
        const reasonMsg = tokenConfirmedRevoked
          ? 'Session invalid or revoked. Click Re-login to verify.'
          : 'Re-authorization required. Click Re-login to verify.';
        await this.markAccountNotVerified(
          accounts,
          target,
          tokens,
          reasonMsg,
          isSilent,
          missingScopes,
          false
        );
        return false;
      }

      // 1. If the user manually chose this account, disable auto-switch so it won't override their choice
      if (isManual) {
        await this.storage.setAutoSwitchEnabled(false);
      }

      // Broadcast cross-window switch lock before mutating keyring/USS/hubs so other IDE instances
      // pause their 2.5s session polls until verifyIdeAcceptedSession completes.
      this.storage.broadcastSwitchStarted?.(email);

      // 2. Update IDE state database (state.vscdb) and cloud agent DB in-place FIRST
      // so disk records and storage entries have the target email ready before any reconnect
      await this.storage.syncToIdeStateDb(target, tokens, false);
      await this.storage.syncToCloudAccountsDb(email);

      // 3. Update google_accounts.json so active email is aligned
      await this.storage.syncGoogleAccountsJson(email);

      // Clear any previous account's shared IDE quota snapshot before mutating IDE auth state
      clearSharedIdeQuotaCache();

      // 4. Hot-switch in-memory via Unified State Sync API so language server and agent immediately get the new token!
      await this.storage.liveSwitchOAuthToken(target, tokens, false, true, true);
      // Record cooldown timestamp only once IDE state mutation actually occurred (so pre-flight failures allow instant auto-switch fallback).
      this.lastSwitchTime = Date.now();

      // 4b. Post-switch verification: ensure Antigravity IDE accepted the session and did not sign out to the Google Login prompt.
      const ideAcceptance = await this.verifyIdeAcceptedSession(email);
      if (!ideAcceptance.accepted) {
        console.warn(`[Antigravity Swap] IDE rejected switched session for ${email}: ${ideAcceptance.reason}`);
        this.ctx.setIdeSessionEmail?.(ideAcceptance.observedIdeEmail);
        await this.markAccountNotVerified(
          accounts,
          target,
          tokens,
          ideAcceptance.reason || 'Not verified for IDE. Click Re-login to verify.',
          isSilent,
          undefined,
          true
        );
        return false;
      }

      // 5. Update internal state and persist active account BEFORE broadcasting so secondary windows read authoritative disk state
      const updatedAccounts = accounts.map((a) => ({
        ...a,
        isActive: a.email === email,
        lastUsedAt: a.email === email ? new Date().toISOString() : a.lastUsedAt
      }));
      this.ctx.setAccounts(updatedAccounts);
      this.ctx.setActiveEmail(email);
      this.ctx.setIdeSessionEmail?.(email.trim().toLowerCase());
      await this.storage.saveAccounts(updatedAccounts);
      await this.storage.setActiveAccountEmail(email);

      // 6. Broadcast switch event to all other open IDE instances
      this.storage.broadcastSwitchCompleted(email);
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
      this.storage.clearSwitchInProgress?.();
      this.isSwitching = false;
      this.switchingEmail = undefined;
      this.ctx.notifyStateChange();
    }
  }
}
