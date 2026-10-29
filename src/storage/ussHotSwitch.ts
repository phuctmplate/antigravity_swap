import * as vscode from 'vscode';
import { AccountInfo, OAuthTokens } from '../types';
import { patchUserStatusPayload } from './protoUtils';
import { writeAntigravityKeyringToken } from './winCredManager';

export class UssHotSwitchService {
  /**
   * Performs an instant in-memory hot switch via Antigravity Unified State Sync (USS) API
   * and Antigravity IDE v2.6+ Hub Keyring & RPC commands.
   * Updates userStatus, OAuthTokenInfo, and Windows Credential Manager (gemini:antigravity)
   * so the IDE, Language Server, and AI Agent immediately pick up the new credentials with zero reload.
   */
  public async liveSwitchOAuthToken(account: AccountInfo, tokens: OAuthTokens): Promise<boolean> {
    let ussSwitched = false;
    let keyringSwitched = false;

    let registeredCommands = new Set<string>();
    try {
      const cmds = await vscode.commands.getCommands(true);
      registeredCommands = new Set(cmds);
    } catch {}

    // Part 1: Antigravity IDE v2.6+ Hub Keyring & AuthClient Cache Swap
    try {
      const hasV26InternalAuth =
        registeredCommands.has('antigravity.internal.logout') ||
        registeredCommands.has('antigravity.internal.getAuthStatus');

      // 1a. Evict in-memory AuthClient cache in agy.exe --hub before writing the new credential
      if (registeredCommands.has('antigravity.internal.logout')) {
        try {
          await vscode.commands.executeCommand('antigravity.internal.logout');
          console.log('[UssHotSwitchService] Cleared agy.exe in-memory AuthClient cache via antigravity.internal.logout');
        } catch (logoutErr) {
          console.warn('[UssHotSwitchService] antigravity.internal.logout warning:', logoutErr);
        }
      }

      // 1b. Write new StoredToken payload to Windows Credential Manager (gemini:antigravity)
      keyringSwitched = await writeAntigravityKeyringToken(account.email, tokens);
      if (keyringSwitched) {
        console.log(`[UssHotSwitchService] Updated gemini:antigravity keyring token for ${account.email}`);
      }

      // 1c. Trigger tryRestoreStoredToken() inside agy.exe --hub via getAuthStatus
      if (hasV26InternalAuth && registeredCommands.has('antigravity.internal.getAuthStatus')) {
        try {
          const authStatus: any = await vscode.commands.executeCommand('antigravity.internal.getAuthStatus');
          console.log(
            `[UssHotSwitchService] Restored agy.exe AuthClient session for ${account.email} (hasValidAuth=${authStatus?.hasValidAuth})`
          );
        } catch (statusErr) {
          console.warn('[UssHotSwitchService] antigravity.internal.getAuthStatus warning:', statusErr);
        }
      }
    } catch (v26Err) {
      console.warn('[UssHotSwitchService] v2.6 Hub hot-switch warning:', v26Err);
    }

    // Part 2: In-memory Unified State Sync (USS) API for Workbench & Legacy LS
    try {
      const unifiedSync = (vscode as any).antigravityUnifiedStateSync;
      if (unifiedSync) {
        const isGcpTos =
          !account.email.toLowerCase().endsWith('@gmail.com') &&
          !account.email.toLowerCase().endsWith('@googlemail.com');

        // 2a. If existing UserStatus is present in memory, patch email/name/avatar while strictly PRESERVING models!
        if (unifiedSync.UserStatus && typeof unifiedSync.UserStatus.getUserStatus === 'function') {
          try {
            const rawStatus = await unifiedSync.UserStatus.getUserStatus();
            if (rawStatus) {
              const existingBytes = Buffer.from(rawStatus, 'base64');
              if (existingBytes.length > 50) {
                const patchedBytes = patchUserStatusPayload(existingBytes, account.email, account.name, account.avatarUrl);
                const patchedB64 = Buffer.from(patchedBytes).toString('base64');
                if (typeof unifiedSync.pushUpdate === 'function') {
                  await unifiedSync.pushUpdate({
                    topicName: 'uss-userStatus',
                    appliedUpdate: {
                      key: 'userStatusSentinelKey',
                      newRow: {
                        value: patchedB64,
                        eTag: 0
                      }
                    }
                  });
                  console.log(`[UssHotSwitchService] Patched in-memory userStatus for ${account.email} preserving model configs`);
                }
              }
            }
          } catch (usErr) {
            console.warn('[UssHotSwitchService] patch in-memory userStatus warning:', usErr);
          }
        }

        // 2b. Set OAuth token info in Unified State Sync
        if (unifiedSync.OAuthPreferences && typeof unifiedSync.OAuthPreferences.setOAuthTokenInfo === 'function') {
          await unifiedSync.OAuthPreferences.setOAuthTokenInfo({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken || '',
            expiryDateSeconds: Math.floor((tokens.expiresAt || Date.now() + 3600000) / 1000),
            tokenType: 'Bearer',
            isGcpTos: isGcpTos
          });
          ussSwitched = true;
          console.log(`[UssHotSwitchService] Successfully hot-switched OAuth token for ${account.email} via antigravityUnifiedStateSync!`);
        }

        // 2c. Push authStateWithContextSentinelKey: {"state":"signedIn"} to uss-oauth!
        if (typeof unifiedSync.pushUpdate === 'function') {
          const authStatePayload = JSON.stringify({
            state: 'signedIn',
            context: {
              project: '',
              showProjectError: false,
              errorMessage: '',
              ineligibleMessage: '',
              verificationUrl: '',
              isGcpTos: isGcpTos,
              browserOpenFailed: false,
              appealUrl: '',
              appealLinkText: ''
            }
          });
          try {
            await unifiedSync.pushUpdate({
              topicName: 'uss-oauth',
              appliedUpdate: {
                key: 'authStateWithContextSentinelKey',
                newRow: {
                  value: authStatePayload,
                  eTag: 0
                }
              }
            });
            ussSwitched = true;
            console.log('[UssHotSwitchService] Successfully pushed authStateWithContextSentinelKey: signedIn');
          } catch (asErr) {
            console.warn('[UssHotSwitchService] pushUpdate authState warning:', asErr);
          }
        }
      }
    } catch (err) {
      console.warn('[UssHotSwitchService] liveSwitchOAuthToken USS warning:', err);
    }

    // Part 3: Trigger IDE UI / Language Server refresh commands if registered
    if (registeredCommands.has('antigravity.handleAuthRefresh')) {
      try {
        await vscode.commands.executeCommand('antigravity.handleAuthRefresh');
        console.log('[UssHotSwitchService] Triggered antigravity.handleAuthRefresh successfully');
      } catch (refErr) {
        console.warn('[UssHotSwitchService] handleAuthRefresh warning:', refErr);
      }
    }

    if (registeredCommands.has('antigravity.reconnect')) {
      try {
        await vscode.commands.executeCommand('antigravity.reconnect');
        console.log('[UssHotSwitchService] Triggered antigravity.reconnect successfully');
      } catch (recErr) {
        console.warn('[UssHotSwitchService] antigravity.reconnect warning:', recErr);
      }
    }

    return ussSwitched || keyringSwitched;
  }
}
