import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { AccountInfo, OAuthTokens } from '../types';
import {
  patchUserStatusPayload,
  buildOnboardingStateCompletedUpdate
} from './protoUtils';
import { writeAntigravityKeyringToken } from './winCredManager';

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
        const extId = 'google.google-antigravity';
        let currentData: any = {};
        try {
          if (typeof extHostStorage.initializeExtensionStorage === 'function') {
            currentData = await extHostStorage.initializeExtensionStorage(true, extId, {});
          }
        } catch {}
        if (!currentData || typeof currentData !== 'object') {
          currentData = {};
        }

        // If initializeExtensionStorage returned an empty template, merge existing keys from state.vscdb
        // so we NEVER wipe out user projectsOrder, conversation layout, or existing settings!
        if (!currentData['antigravity-storage'] || Object.keys(currentData['antigravity-storage']).length === 0) {
          try {
            const stateDbPath = path.join(
              os.homedir(),
              'AppData',
              'Roaming',
              'Antigravity IDE',
              'User',
              'globalStorage',
              'state.vscdb'
            );
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const sqliteModule = (globalThis as any).require ? (globalThis as any).require('node:sqlite') : require('node:sqlite');
            if (sqliteModule && sqliteModule.DatabaseSync && fs.existsSync(stateDbPath)) {
              const db = new sqliteModule.DatabaseSync(stateDbPath);
              const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(extId);
              if (row && row.value) {
                const parsed = JSON.parse(row.value);
                currentData = { ...parsed, ...currentData };
              }
              db.close();
            }
          } catch {}
        }

        if (!currentData['antigravity-storage'] || typeof currentData['antigravity-storage'] !== 'object') {
          currentData['antigravity-storage'] = {};
        }

        const isGcpTos =
          !email.toLowerCase().endsWith('@gmail.com') &&
          !email.toLowerCase().endsWith('@googlemail.com') &&
          !email.toLowerCase().endsWith('@example.com');
        const gcpTosStr = isGcpTos ? 'true' : 'false';

        currentData['antigravity-storage']['agy.onboarding.lastLoginUsername'] = email;
        currentData['antigravity-storage']['agy.onboarding.lastLoginIsGcpTos'] = gcpTosStr;
        currentData['antigravity-storage']['agy.onboarding.lastLoginStrategy'] = 'google';
        currentData['antigravity-storage']['jetski.onboarding.lastLoginUsername'] = email;
        currentData['antigravity-storage']['jetski.onboarding.lastLoginIsGcpTos'] = gcpTosStr;
        currentData['antigravity-storage']['jetski.onboarding.lastLoginStrategy'] = 'google';

        await extHostStorage.setValue(true, extId, currentData);
        if (this.context?.secrets) {
          try {
            const authSyncPayload = JSON.stringify({
              signedIn: true,
              email,
              isGcpTos,
              ts: Date.now()
            });
            await this.context.secrets.store('antigravity.authSync', authSyncPayload);
          } catch {}
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
   * Updates userStatus, OAuthTokenInfo, and Windows Credential Manager (gemini:antigravity)
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

    // Part 1: Antigravity IDE v2.6+ Hub Keyring (target: gemini:antigravity)
    if (!skipKeyring) {
      try {
        // 1a. Write new StoredToken payload directly into Windows Credential Manager
        // NOTE: NEVER call antigravity.internal.logout here! Calling internal.logout invokes AuthLogoutRequest
        // on the Language Server, which triggers onDidLogout in workbench, wipes authenticationService sessions,
        // and permanently leaves the chat conversation in a "Not logged in" state.
        keyringSwitched = await writeAntigravityKeyringToken(account.email, tokens);
        if (keyringSwitched) {
          console.log(`[UssHotSwitchService] Updated gemini:antigravity keyring token for ${account.email}`);
        }
      } catch (v26Err) {
        console.warn('[UssHotSwitchService] v2.6 Hub keyring write warning:', v26Err);
      }
    } else {
      keyringSwitched = true;
    }

    // Part 2: In-memory Unified State Sync (USS) API for Workbench & Legacy LS
    try {
      const unifiedSync = (vscode as any).antigravityUnifiedStateSync;
      if (unifiedSync) {
        const isGcpTos =
          !account.email.toLowerCase().endsWith('@gmail.com') &&
          !account.email.toLowerCase().endsWith('@googlemail.com');

        // 2a. If existing UserStatus is present in memory, patch email/name/avatar while strictly PRESERVING models!
        //     Ensure agentOnboardingCompleted = 1 (COMPLETED) so the Language Server and AI Agent are authorized
        //     to execute prompts cleanly without terminating with 'Unknown: Agent execution terminated due to error'.
        if (unifiedSync.UserStatus && typeof unifiedSync.UserStatus.getUserStatus === 'function') {
          try {
            const rawStatus = await unifiedSync.UserStatus.getUserStatus();
            if (rawStatus) {
              const existingBytes = Buffer.from(rawStatus, 'base64');
              if (existingBytes.length > 50) {
                // In Antigravity IDE 2.7+, agentOnboardingCompleted is an enum: 0=UNSET, 1=RESET/IN_PROGRESS, 2=COMPLETED
                // Setting 2 permanently guarantees the chat webview and LS recognize onboarding as fully completed!
                const onboardingOverride = 2;
                const patchedBytes = patchUserStatusPayload(
                  existingBytes,
                  account.email,
                  account.name,
                  account.avatarUrl,
                  onboardingOverride
                );
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
                  console.log(`[UssHotSwitchService] Patched in-memory userStatus for ${account.email} preserving model configs and onboardingCompleted=2`);
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

        // 2d. Push uss-onboardingState: agentOnboardingStateSentinelKey = COMPLETED (2)
        // Whenever pushOnboarding is true (including secondary instances where triggerReconnect = false),
        // push agentOnboardingState = COMPLETED so the chat conversation in all open IDE windows
        // immediately recognizes onboarding is completed and suppresses the new account dialog!
        if (pushOnboarding && typeof unifiedSync.pushUpdate === 'function') {
          try {
            await unifiedSync.pushUpdate(buildOnboardingStateCompletedUpdate());
            console.log(`[UssHotSwitchService] Pushed uss-onboardingState COMPLETED for ${account.email}`);
          } catch (obErr) {
            console.warn('[UssHotSwitchService] pushUpdate uss-onboardingState warning:', obErr);
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
