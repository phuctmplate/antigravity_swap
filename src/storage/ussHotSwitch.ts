import * as vscode from 'vscode';
import { AccountInfo, OAuthTokens } from '../types';
import { patchUserStatusPayload } from './protoUtils';

export class UssHotSwitchService {
  /**
   * Performs an instant in-memory hot switch via Antigravity Unified State Sync (USS) API.
   * Updates userStatus and OAuthTokenInfo in Unified State Sync so the IDE, Language Server,
   * and AI Agent immediately pick up the new credentials with zero reload.
   */
  public async liveSwitchOAuthToken(account: AccountInfo, tokens: OAuthTokens): Promise<boolean> {
    try {
      const unifiedSync = (vscode as any).antigravityUnifiedStateSync;
      if (unifiedSync) {
        const isGcpTos = !account.email.toLowerCase().endsWith('@gmail.com') && !account.email.toLowerCase().endsWith('@googlemail.com');

        // 1. If existing UserStatus is present in memory, patch email/name/avatar while strictly PRESERVING models!
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

        // 2. Set OAuth token info in Unified State Sync
        if (unifiedSync.OAuthPreferences && typeof unifiedSync.OAuthPreferences.setOAuthTokenInfo === 'function') {
          await unifiedSync.OAuthPreferences.setOAuthTokenInfo({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken || '',
            expiryDateSeconds: Math.floor((tokens.expiresAt || Date.now() + 3600000) / 1000),
            tokenType: 'Bearer',
            isGcpTos: isGcpTos
          });

          console.log(`[UssHotSwitchService] Successfully hot-switched OAuth token for ${account.email} via antigravityUnifiedStateSync!`);
        }

        // 3. Push authStateWithContextSentinelKey: {"state":"signedIn"} to uss-oauth!
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
            console.log('[UssHotSwitchService] Successfully pushed authStateWithContextSentinelKey: signedIn');
          } catch (asErr) {
            console.warn('[UssHotSwitchService] pushUpdate authState warning:', asErr);
          }
        }

        // 4. Trigger handleAuthRefresh immediately so the IDE updates sessions and evicts old accounts
        try {
          await vscode.commands.executeCommand('antigravity.handleAuthRefresh');
          console.log('[UssHotSwitchService] Triggered antigravity.handleAuthRefresh successfully');
        } catch (refErr) {
          console.warn('[UssHotSwitchService] handleAuthRefresh warning:', refErr);
        }

        return true;
      }
    } catch (err) {
      console.warn('[UssHotSwitchService] liveSwitchOAuthToken warning:', err);
    }
    return false;
  }
}
