import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { AccountInfo, OAuthTokens } from '../types';
import {
  createUserStatusPayload,
  patchUserStatusPayload,
  buildOnboardingStateCompletedUpdate
} from './protoUtils';
import { writeAntigravityKeyringToken } from './winCredManager';
import { getAntigravityStateDbPath, isGcpTosEmail } from './accountDiscovery';
import { forceReloadAllLocalAgyHubs } from '../quota';

export class UssHotSwitchService {
  constructor(private readonly context?: vscode.ExtensionContext) {}

  /**
   * Synchronizes in-memory core extension storage ('google.google-antigravity')
   * with the target account email so that webview components (which read terms acceptance
   * via storageGetItems -> jetski.onboarding.lastLoginUsername) see that terms have already
   * been accepted on this device, cleanly suppressing the FTUE dialog on switch.
   */
  public async syncCoreExtensionStorage(email: string): Promise<boolean> {
    try {
      const extHostStorage = (this.context?.globalState as any)?._storage;
      if (extHostStorage && typeof extHostStorage.setValue === 'function') {
        const primaryExtId = 'google.google-antigravity';
        const secondaryExtId = 'google.antigravity';
        const isGcpTos = isGcpTosEmail(email);
        const gcpTosStr = isGcpTos ? 'true' : 'false';
        const stateDbPath = getAntigravityStateDbPath();

        // Read existing DB entries once as fallback when initializeExtensionStorage returns an empty template
        let dbRows: Record<string, any> = {};
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const sqliteModule = (globalThis as any).require ? (globalThis as any).require('node:sqlite') : require('node:sqlite');
          if (sqliteModule && sqliteModule.DatabaseSync && fs.existsSync(stateDbPath)) {
            const db = new sqliteModule.DatabaseSync(stateDbPath);
            for (const extId of [primaryExtId, secondaryExtId]) {
              const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(extId);
              if (row && row.value) {
                try {
                  dbRows[extId] = JSON.parse(row.value);
                } catch {}
              }
            }
            db.close();
          }
        } catch {}

        const extIds = dbRows[secondaryExtId]?.['antigravity-storage']
          ? [secondaryExtId, primaryExtId]
          : [primaryExtId];

        for (const extId of extIds) {
          let currentData: any = {};
          try {
            if (typeof extHostStorage.initializeExtensionStorage === 'function') {
              currentData = await extHostStorage.initializeExtensionStorage(true, extId, {});
            }
          } catch {}
          if (!currentData || typeof currentData !== 'object') {
            currentData = {};
          }

          if (!currentData['antigravity-storage'] || Object.keys(currentData['antigravity-storage']).length === 0) {
            if (dbRows[extId] && typeof dbRows[extId] === 'object') {
              currentData = { ...dbRows[extId], ...currentData };
            }
          }

          if (!currentData['antigravity-storage'] || typeof currentData['antigravity-storage'] !== 'object') {
            currentData['antigravity-storage'] = {};
          }

          currentData['antigravity-storage']['agy.onboarding.lastLoginUsername'] = email;
          currentData['antigravity-storage']['agy.onboarding.lastLoginIsGcpTos'] = gcpTosStr;
          currentData['antigravity-storage']['agy.onboarding.lastLoginStrategy'] = 'google';
          currentData['antigravity-storage']['jetski.onboarding.lastLoginUsername'] = email;
          currentData['antigravity-storage']['jetski.onboarding.lastLoginIsGcpTos'] = gcpTosStr;
          currentData['antigravity-storage']['jetski.onboarding.lastLoginStrategy'] = 'google';

          await extHostStorage.setValue(true, extId, currentData);
        }

        console.log(`[UssHotSwitchService] Synced in-memory core extension storage for ${email}`);
        return true;
      }
    } catch (err) {
      console.warn('[UssHotSwitchService] syncCoreExtensionStorage warning:', err);
    }
    return false;
  }

  /**
   * Performs an instant in-memory hot switch via Antigravity Unified State Sync (USS) API
   * and Antigravity IDE v2.6+ Hub Keyring & RPC commands.
   * Updates onboarding state, userStatus, OAuthTokenInfo, and Windows Credential Manager (gemini:antigravity)
   * so the IDE, Language Server, and AI Agent immediately pick up the new credentials with zero reload.
   */
  public async liveSwitchOAuthToken(
    account: AccountInfo,
    tokens: OAuthTokens,
    skipKeyring = false,
    triggerReconnect = true,
    pushOnboarding = true
  ): Promise<boolean> {
    let ussSwitched = false;
    let keyringSwitched = false;

    // Synchronize core extension storage in memory before tokens switch so the webview never observes a mismatch
    await this.syncCoreExtensionStorage(account.email);

    let registeredCommands = new Set<string>();
    try {
      const cmds = await vscode.commands.getCommands(true);
      registeredCommands = new Set(cmds);
    } catch {}

    // Part 1: In-memory Unified State Sync (USS) onboarding & userStatus FIRST
    // so IDE auth listeners (handleAuthRefresh / onboarding router) always see COMPLETED state
    // before OAuth tokens or Keyring change.
    try {
      const unifiedSync = (vscode as any).antigravityUnifiedStateSync;
      if (unifiedSync) {
        const isGcpTos = isGcpTosEmail(account.email);

        // 1a. Push uss-onboardingState: agentOnboardingStateSentinelKey = COMPLETED (2) BEFORE OAuth change
        if (pushOnboarding && typeof unifiedSync.pushUpdate === 'function') {
          try {
            await unifiedSync.pushUpdate(buildOnboardingStateCompletedUpdate());
            console.log(`[UssHotSwitchService] Pushed uss-onboardingState COMPLETED for ${account.email}`);
          } catch (obErr) {
            console.warn('[UssHotSwitchService] pushUpdate uss-onboardingState warning:', obErr);
          }
        }

        // 1b. If existing UserStatus is present in memory, patch email/name/avatar while strictly PRESERVING models!
        //     If IDE was signed out and has no valid UserStatus in memory, create a clean baseline payload so the
        //     Language Server & IDE auth handshake never sees an empty userStatus.
        if (unifiedSync.UserStatus && typeof unifiedSync.UserStatus.getUserStatus === 'function') {
          try {
            const rawStatus = await unifiedSync.UserStatus.getUserStatus();
            const existingBytes = rawStatus ? Buffer.from(rawStatus, 'base64') : null;
            const onboardingOverride = 2;
            const statusBytes = existingBytes && existingBytes.length > 50
              ? patchUserStatusPayload(
                  existingBytes,
                  account.email,
                  account.name,
                  account.avatarUrl,
                  onboardingOverride
                )
              : createUserStatusPayload(account.email, account.name);

            if (typeof unifiedSync.pushUpdate === 'function') {
              const statusB64 = Buffer.from(statusBytes).toString('base64');
              await unifiedSync.pushUpdate({
                topicName: 'uss-userStatus',
                appliedUpdate: {
                  key: 'userStatusSentinelKey',
                  newRow: {
                    value: statusB64,
                    eTag: 0
                  }
                }
              });
              console.log(
                `[UssHotSwitchService] Pushed in-memory userStatus (${existingBytes && existingBytes.length > 50 ? 'patched' : 'created baseline'}) for ${account.email}`
              );
            }
          } catch (usErr) {
            console.warn('[UssHotSwitchService] patch in-memory userStatus warning:', usErr);
          }
        }

        // 1c. Push authStateWithContextSentinelKey: {"state":"signedIn"} to uss-oauth before updating OAuth token
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

        // 1d. Set OAuth token info in Unified State Sync (triggers IDE OAuth listener after onboarding is COMPLETED)
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
      }
    } catch (err) {
      console.warn('[UssHotSwitchService] liveSwitchOAuthToken USS warning:', err);
    }

    // Part 2: Antigravity IDE v2.6+ Hub Keyring (target: gemini:antigravity)
    if (!skipKeyring) {
      try {
        // NOTE: NEVER call antigravity.internal.logout here! Calling internal.logout invokes AuthLogoutRequest
        // on the Language Server, which triggers onDidLogout in workbench, wipes authenticationService sessions,
        // and permanently leaves the chat conversation in a "Not logged in" state.
        keyringSwitched = await writeAntigravityKeyringToken(account.email, tokens);
        if (keyringSwitched) {
          console.log(`[UssHotSwitchService] Updated gemini:antigravity keyring token for ${account.email}`);
          // Force all running agy.exe hubs to sync with the new stored token immediately
          await forceReloadAllLocalAgyHubs(2500).catch(() => {});
        }
      } catch (v26Err) {
        console.warn('[UssHotSwitchService] v2.6 Hub keyring write warning:', v26Err);
      }
    } else {
      keyringSwitched = true;
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

    // Reconnect the conversation and language server stream ONLY when switching to a different account.
    // For background token refreshes of the same active account, reconnect is skipped to avoid reloading the chat UI!
    if (triggerReconnect && registeredCommands.has('antigravity.reconnect')) {
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
