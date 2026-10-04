import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as cp from 'child_process';
import { AccountInfo, OAuthTokens, AutoSwitchTarget } from './types';
import { STORAGE_KEYS, CONFIG_KEYS, EXTENSION_DEFAULTS } from './constants';

export interface DiscoveredAccount {
  email: string;
  name: string;
  avatarUrl?: string;
  accessToken?: string;
  refreshToken?: string;
}

export class StorageService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly secrets: vscode.SecretStorage
  ) {}

  public getAccounts(): AccountInfo[] {
    return this.context.globalState.get<AccountInfo[]>(STORAGE_KEYS.ACCOUNTS, []);
  }

  public async saveAccounts(accounts: AccountInfo[]): Promise<void> {
    await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS, accounts);
  }

  public getActiveAccountEmail(): string | undefined {
    return this.context.globalState.get<string>(STORAGE_KEYS.ACTIVE_ACCOUNT);
  }

  public async setActiveAccountEmail(email: string | undefined): Promise<void> {
    await this.context.globalState.update(STORAGE_KEYS.ACTIVE_ACCOUNT, email);
  }

  public getAutoSwitchEnabled(): boolean {
    return this.context.globalState.get<boolean>(STORAGE_KEYS.AUTO_SWITCH, true);
  }

  public async setAutoSwitchEnabled(enabled: boolean): Promise<void> {
    await this.context.globalState.update(STORAGE_KEYS.AUTO_SWITCH, enabled);
  }

  public getAutoSwitchTarget(): AutoSwitchTarget {
    const config = vscode.workspace.getConfiguration(CONFIG_KEYS.SECTION);
    const configTarget = config.get<AutoSwitchTarget>(CONFIG_KEYS.AUTO_SWITCH_TARGET);
    if (configTarget && (configTarget === 'total' || configTarget === 'gemini' || configTarget === 'claude')) {
      return configTarget;
    }
    return this.context.globalState.get<AutoSwitchTarget>(STORAGE_KEYS.AUTO_SWITCH_TARGET, EXTENSION_DEFAULTS.DEFAULT_AUTO_SWITCH_TARGET);
  }

  public async setAutoSwitchTarget(target: AutoSwitchTarget): Promise<void> {
    await this.context.globalState.update(STORAGE_KEYS.AUTO_SWITCH_TARGET, target);
    try {
      const config = vscode.workspace.getConfiguration(CONFIG_KEYS.SECTION);
      await config.update(CONFIG_KEYS.AUTO_SWITCH_TARGET, target, vscode.ConfigurationTarget.Global);
    } catch {
      // Ignore if config update fails
    }
  }

  public async getAccountTokens(email: string): Promise<OAuthTokens | null> {
    const raw = await this.secrets.get(`antigravitySwap.tokens.${email}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OAuthTokens;
    } catch {
      return null;
    }
  }

  public async saveAccountTokens(email: string, tokens: OAuthTokens): Promise<void> {
    await this.secrets.store(`antigravitySwap.tokens.${email}`, JSON.stringify(tokens));
  }

  public async removeAccountTokens(email: string): Promise<void> {
    await this.secrets.delete(`antigravitySwap.tokens.${email}`);
  }

  private getSqliteDb(dbPath: string): any {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sqliteModule = (globalThis as any).require ? (globalThis as any).require('node:sqlite') : require('node:sqlite');
      if (sqliteModule && sqliteModule.DatabaseSync) {
        return new sqliteModule.DatabaseSync(dbPath);
      }
    } catch {}
    return null;
  }

  private async execSqliteUpsert(dbPath: string, key: string, value: string): Promise<boolean> {
    const nativeDb = this.getSqliteDb(dbPath);
    if (nativeDb) {
      try {
        const upsert = nativeDb.prepare(
          'INSERT INTO ItemTable (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        );
        upsert.run(key, value);
        nativeDb.close();
        return true;
      } catch (e) {
        console.warn('Native sqlite upsert failed:', e);
      }
    }

    // Fallback: spawn system node process
    return new Promise((resolve) => {
      const script = `
        try {
          const sqlite = require('node:sqlite');
          const db = new sqlite.DatabaseSync(${JSON.stringify(dbPath)});
          const upsert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
          upsert.run(${JSON.stringify(key)}, ${JSON.stringify(value)});
          db.close();
          process.exit(0);
        } catch (e) {
          process.exit(1);
        }
      `;
      cp.execFile('node', ['-e', script], (err) => {
        if (!err) {
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

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
        // We NEVER overwrite with a stripped 5-field skeleton that wipes out clientModelConfigs and avatar!
        if (unifiedSync.UserStatus && typeof unifiedSync.UserStatus.getUserStatus === 'function') {
          try {
            const rawStatus = await unifiedSync.UserStatus.getUserStatus();
            if (rawStatus) {
              const existingBytes = Buffer.from(rawStatus, 'base64');
              // Only patch if existing status has actual content
              if (existingBytes.length > 50) {
                const patchedBytes = this.patchUserStatusPayload(existingBytes, account.email, account.name, account.avatarUrl);
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
                  console.log(`[Antigravity Swap] Patched in-memory userStatus for ${account.email} preserving model configs`);
                }
              }
            }
          } catch (usErr) {
            console.warn('[Antigravity Swap] patch in-memory userStatus warning:', usErr);
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

          console.log(`[Antigravity Swap] Successfully hot-switched OAuth token for ${account.email} via antigravityUnifiedStateSync!`);
        }

        // 3. Push authStateWithContextSentinelKey: {"state":"signedIn"} to uss-oauth!
        // This is CRITICAL: Antigravity IDE derives _authState from this key.
        // If missing or not "signedIn", workbench hides the avatar and disables models!
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
            console.log('[Antigravity Swap] Successfully pushed authStateWithContextSentinelKey: signedIn');
          } catch (asErr) {
            console.warn('[Antigravity Swap] pushUpdate authState warning:', asErr);
          }
        }

        // 4. Trigger handleAuthRefresh immediately so the IDE updates sessions and evicts old accounts
        try {
          await vscode.commands.executeCommand('antigravity.handleAuthRefresh');
          console.log('[Antigravity Swap] Triggered antigravity.handleAuthRefresh successfully');
        } catch (refErr) {
          console.warn('[Antigravity Swap] handleAuthRefresh warning:', refErr);
        }

        return true;
      }
    } catch (err) {
      console.warn('[Antigravity Swap] liveSwitchOAuthToken warning:', err);
    }
    return false;
  }

  /**
   * Syncs active account to ~/.gemini/google_accounts.json if it exists.
   */
  public async syncGoogleAccountsJson(email: string): Promise<boolean> {
    const filePath = path.join(os.homedir(), '.gemini', 'google_accounts.json');
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        const oldActive = data.active;
        const oldList: string[] = Array.isArray(data.old) ? data.old : [];
        if (oldActive && oldActive !== email && !oldList.includes(oldActive)) {
          oldList.push(oldActive);
        }
        data.active = email;
        data.old = oldList.filter((e: string) => e !== email);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        console.log(`[Antigravity Swap] Synced active account in google_accounts.json to ${email}`);
        return true;
      }
    } catch (e) {
      console.warn('[Antigravity Swap] syncGoogleAccountsJson warning:', e);
    }
    return false;
  }

  /**
   * Performs seamless account injection via a detached background worker process:
   * 1. Saves all credentials and state rows to a temporary payload
   * 2. Spawns a detached worker process with ELECTRON_RUN_AS_NODE=1
   * 3. Closes the Antigravity window (triggering memory flush to disk)
   * 4. Worker waits for IDE processes to exit, writes new tokens into state.vscdb via SQLite, and relaunches Antigravity IDE!
   */
  public async injectAccountStateAndRelaunch(
    account: AccountInfo,
    tokens: OAuthTokens,
    allAccounts: AccountInfo[]
  ): Promise<boolean> {
    const stateDbPath = path.join(
      os.homedir(),
      'AppData',
      'Roaming',
      'Antigravity IDE',
      'User',
      'globalStorage',
      'state.vscdb'
    );

    if (!fs.existsSync(stateDbPath)) {
      vscode.window.showErrorMessage('Antigravity IDE state database not found.');
      return false;
    }

    try {
      // 1. Build database rows for injection
      const authStatus = JSON.stringify({
        name: account.name || account.email.split('@')[0],
        email: account.email,
        apiKey: tokens.accessToken
      });

      const unifiedOAuth = this.createUnifiedOAuthToken(
        tokens.accessToken,
        tokens.refreshToken || '',
        Math.floor((tokens.expiresAt || Date.now() + 3600000) / 1000),
        false,
        undefined,
        account.email
      );

      // Prepare updated accounts list
      const updatedAccounts = allAccounts.map((a) => ({
        ...a,
        isActive: a.email === account.email,
        lastUsedAt: a.email === account.email ? new Date().toISOString() : a.lastUsedAt
      }));

      const extensionStateValue = JSON.stringify({
        'antigravitySwap.accounts': updatedAccounts,
        'antigravitySwap.activeEmail': account.email
      });

      // Safely preserve existing userStatus models if available in stateDb, or remove corrupted skeleton
      let patchedUserStatusTopic: string | null = null;
      try {
        const nativeDb = this.getSqliteDb(stateDbPath);
        if (nativeDb) {
          const row = nativeDb.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravityUnifiedStateSync.userStatus');
          if (row && row.value && row.value.length > 250) {
            patchedUserStatusTopic = this.patchUnifiedStateSyncTopicUserStatus(
              Buffer.from(row.value, 'base64'),
              account.email,
              account.name,
              account.avatarUrl
            );
          }
          nativeDb.close();
        }
      } catch {}

      const rows: Array<{ key: string; value: string | null }> = [
        { key: 'antigravityAuthStatus', value: authStatus },
        { key: 'antigravityUnifiedStateSync.oauthToken', value: unifiedOAuth },
        { key: 'antigravityUnifiedStateSync.userStatus', value: patchedUserStatusTopic },
        { key: 'antigravityOnboarding', value: 'true' },
        { key: 'antigravitySwap.activeEmail', value: account.email },
        { key: 'antigravity-community.antigravity-swap', value: extensionStateValue },
        { key: 'phuctmplate.antigravity-swap', value: extensionStateValue }
      ];

      if (account.avatarUrl) {
        rows.push({ key: 'antigravity.profileUrl', value: account.avatarUrl });
      }

      // Collect relaunch candidate paths
      const currentExe = process.execPath;
      const candidatePaths = [
        currentExe,
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe')
      ].filter((p, i, arr) => p && arr.indexOf(p) === i && fs.existsSync(p));

      const workDir = path.join(os.homedir(), '.antigravity-swap');
      if (!fs.existsSync(workDir)) {
        fs.mkdirSync(workDir, { recursive: true });
      }

      const payloadPath = path.join(workDir, '.inject-payload.json');
      const workerPath = path.join(workDir, '.inject-worker.js');

      const workspaceFolders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];

      const payloadObj = {
        dbPath: stateDbPath,
        rows,
        exeCandidates: candidatePaths,
        workspacePaths: workspaceFolders
      };

      fs.writeFileSync(payloadPath, JSON.stringify(payloadObj, null, 2), 'utf-8');
      fs.writeFileSync(workerPath, this.getWorkerScriptContent(), 'utf-8');

      // Spawn detached background worker
      const workerEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
      const child = cp.spawn(currentExe, [workerPath, payloadPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: workDir,
        env: workerEnv
      });
      child.unref();

      console.log(`[Antigravity Swap] Detached inject worker spawned (PID: ${child.pid}). Closing window to flush & restart...`);

      // Close window so Antigravity IDE finishes saving and exits
      await vscode.commands.executeCommand('workbench.action.closeWindow');
      return true;
    } catch (err: any) {
      console.error('[Antigravity Swap] Failed to launch injection worker:', err);
      vscode.window.showErrorMessage(`Switch failed: ${err.message}`);
      return false;
    }
  }

  private getWorkerScriptContent(): string {
    return `
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const payloadPath = process.argv[2];
if (!payloadPath || !fs.existsSync(payloadPath)) {
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(payloadPath, 'utf-8'));
} catch (e) {
  process.exit(1);
}

const { dbPath, rows, exeCandidates, workspacePaths } = payload;
const ownPid = process.pid;

function getOtherAntigravityPids() {
  const pids = [];
  try {
    const exeName = path.basename(process.execPath);
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq ' + exeName + '" /FO CSV /NH', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of out.split('\\n')) {
        const parts = line.split(',');
        if (parts.length > 1) {
          const namePart = parts[0].replace(/"/g, '').trim();
          const pidPart = parts[1].replace(/"/g, '').trim();
          if (namePart.toLowerCase() === exeName.toLowerCase()) {
            const pid = parseInt(pidPart, 10);
            if (pid && pid !== ownPid) pids.push(pid);
          }
        }
      }
    } else {
      const out = execSync('ps -ax -o pid,comm', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of out.split('\\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\\s+/);
        if (parts.length >= 2) {
          const pid = parseInt(parts[0], 10);
          const comm = parts.slice(1).join(' ');
          if (comm.toLowerCase().includes(exeName.toLowerCase())) {
            if (pid && pid !== ownPid) pids.push(pid);
          }
        }
      }
    }
  } catch (e) {}
  return pids;
}

async function waitForAntigravityExit(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pids = getOtherAntigravityPids();
    if (pids.length === 0) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

function forceKillRemainingPids() {
  const pids = getOtherAntigravityPids();
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        execSync('taskkill /F /PID ' + pid, { stdio: 'ignore', windowsHide: true });
      } else {
        execSync('kill -9 ' + pid, { stdio: 'ignore' });
      }
    } catch (e) {}
  }
}

function findRelaunchExe() {
  if (exeCandidates && Array.isArray(exeCandidates)) {
    for (const candidate of exeCandidates) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const fallbacks = [
      path.join(localAppData, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'),
      path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe')
    ];
    for (const p of fallbacks) {
      if (p && fs.existsSync(p)) return p;
    }
  }
  return process.execPath;
}

async function main() {
  // 1. Wait for Antigravity window to close and flush SQLite
  const exited = await waitForAntigravityExit(4500);
  if (!exited) {
    forceKillRemainingPids();
  }

  // 2. Extra safety buffer for file lock release
  await new Promise(r => setTimeout(r, 1200));

  // 3. Inject rows directly into state.vscdb using SQLite
  try {
    const sqlite = require('node:sqlite');
    const db = new sqlite.DatabaseSync(dbPath);
    for (const { key, value } of rows) {
      if (value === null) {
        db.prepare('DELETE FROM ItemTable WHERE key = ?').run(key);
      } else {
        db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
      }
    }
    db.close();
  } catch (dbErr) {
    try {
      const initSqlJs = require('sql.js');
      const SQL = await initSqlJs();
      const buf = fs.readFileSync(dbPath);
      const db = new SQL.Database(buf);
      for (const { key, value } of rows) {
        if (value === null) {
          db.run('DELETE FROM ItemTable WHERE key = ?', [key]);
        } else {
          db.run('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)', [key, value]);
        }
      }
      const out = db.export();
      fs.writeFileSync(dbPath, Buffer.from(out));
      db.close();
    } catch (sqlErr) {}
  }

  // Cleanup payload
  try { fs.unlinkSync(payloadPath); } catch (e) {}

  // 4. Relaunch Antigravity IDE with existing workspace
  try {
    const relaunchExe = findRelaunchExe();
    if (relaunchExe && fs.existsSync(relaunchExe)) {
      const wsArg = (workspacePaths && workspacePaths.length > 0) ? ' "' + workspacePaths[0] + '"' : '';

      if (process.platform === 'win32') {
        const batPath = path.join(path.dirname(payloadPath), '.relaunch.bat');
        const batLines = ['@echo off', 'set ELECTRON_RUN_AS_NODE=', 'start "" "' + relaunchExe + '"' + wsArg, 'del "%~f0"'];
        fs.writeFileSync(batPath, batLines.join('\\r\\n') + '\\r\\n', 'utf-8');

        try {
          const child = spawn('cmd.exe', ['/c', batPath], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          child.unref();
        } catch (batErr) {
          execSync('powershell -NoProfile -Command "Remove-Item Env:ELECTRON_RUN_AS_NODE -EA SilentlyContinue; Start-Process \\\"' + relaunchExe + '\\\" -ArgumentList \\\"' + wsArg.trim() + '\\\""', { stdio: 'ignore', windowsHide: true });
        }
      } else {
        const cleanEnv = { ...process.env };
        delete cleanEnv.ELECTRON_RUN_AS_NODE;
        const args = (workspacePaths && workspacePaths.length > 0) ? [workspacePaths[0]] : [];
        const child = spawn(relaunchExe, args, {
          detached: true,
          stdio: 'ignore',
          env: cleanEnv
        });
        child.unref();
      }
    }
  } catch (relaunchErr) {}
}

main().catch(() => process.exit(1));
`;
  }

  /**
   * Updates Antigravity IDE global state database with valid Unified State Sync protobuf
   * to guarantee that cold-boot / window-reloads retain the switched account.
   */
  public async syncToIdeStateDb(account: AccountInfo, tokens: OAuthTokens, skipUssKeys = false): Promise<boolean> {
    const stateDbPath = path.join(
      os.homedir(),
      'AppData',
      'Roaming',
      'Antigravity IDE',
      'User',
      'globalStorage',
      'state.vscdb'
    );

    if (!fs.existsSync(stateDbPath)) {
      return false;
    }

    try {
      if (tokens.accessToken) {
        // 1. Sync antigravityUnifiedStateSync.oauthToken with both token and signedIn state
        const unifiedOAuth = this.createUnifiedOAuthToken(
          tokens.accessToken,
          tokens.refreshToken || '',
          Math.floor((tokens.expiresAt || Date.now() + 3600000) / 1000),
          false,
          undefined,
          account.email
        );
        await this.execSqliteUpsert(stateDbPath, 'antigravityUnifiedStateSync.oauthToken', unifiedOAuth);

        // 2. Handle antigravityUnifiedStateSync.userStatus safely:
        // We NEVER overwrite with a stripped skeleton!
        // If existing row has real models (> 250 chars), patch email/name/avatar and keep models.
        // If it's a corrupted skeleton (<= 200 chars), delete it so IDE loads fresh from Google!
        try {
          const nativeDb = this.getSqliteDb(stateDbPath);
          if (nativeDb) {
            const existingRow = nativeDb.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravityUnifiedStateSync.userStatus');
            if (existingRow && existingRow.value) {
              if (existingRow.value.length > 250) {
                const topicBuf = Buffer.from(existingRow.value, 'base64');
                const patchedTopic = this.patchUnifiedStateSyncTopicUserStatus(topicBuf, account.email, account.name, account.avatarUrl);
                if (patchedTopic) {
                  nativeDb.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(patchedTopic, 'antigravityUnifiedStateSync.userStatus');
                  console.log(`[Antigravity Swap] Patched state.vscdb userStatus for ${account.email} preserving models`);
                }
              } else if (existingRow.value.length <= 200) {
                nativeDb.prepare('DELETE FROM ItemTable WHERE key = ?').run('antigravityUnifiedStateSync.userStatus');
                console.log('[Antigravity Swap] Removed corrupted skeleton userStatus from state.vscdb');
              }
            }
            nativeDb.close();
          }
        } catch (usDbErr) {
          console.warn('[Antigravity Swap] syncToIdeStateDb userStatus handling warning:', usDbErr);
        }

        // 3. Update antigravityAuthStatus
        const authStatus = JSON.stringify({
          name: account.name || account.email.split('@')[0],
          email: account.email,
          apiKey: tokens.accessToken
        });
        await this.execSqliteUpsert(stateDbPath, 'antigravityAuthStatus', authStatus);
      }

      // Pre-grant extension authentication access to avoid access prompts
      const allowedJson = JSON.stringify([
        { id: 'google.antigravity', name: 'Antigravity', allowed: true },
        { id: 'phuctmplate.antigravity-swap', name: 'Antigravity Swap', allowed: true }
      ]);
      const acctLabel = account.name || account.email;
      await this.execSqliteUpsert(stateDbPath, `antigravity_auth-${acctLabel}`, allowedJson);
      await this.execSqliteUpsert(stateDbPath, `antigravity_auth-${account.email}`, allowedJson);
      await this.execSqliteUpsert(stateDbPath, `antigravity-${acctLabel}`, allowedJson);
      await this.execSqliteUpsert(stateDbPath, `antigravity-${account.email}`, allowedJson);
      await this.execSqliteUpsert(stateDbPath, 'google.antigravity-antigravity_auth', acctLabel);
      await this.execSqliteUpsert(stateDbPath, 'google.antigravity-antigravity', acctLabel);

      // Update onboarding status
      await this.execSqliteUpsert(stateDbPath, 'antigravityOnboarding', 'true');

      // Update profile picture if available
      if (account.avatarUrl) {
        await this.execSqliteUpsert(stateDbPath, 'antigravity.profileUrl', account.avatarUrl);
      }

      return true;
    } catch (err) {
      console.error('[Antigravity Swap] Failed to direct sync state.vscdb:', err);
      return false;
    }
  }

  /**
   * Syncs active account to .antigravity-agent/cloud_accounts.db if the background agent exists.
   */
  public async syncToCloudAccountsDb(email: string): Promise<boolean> {
    const cloudDbPath = path.join(os.homedir(), '.antigravity-agent', 'cloud_accounts.db');
    if (!fs.existsSync(cloudDbPath)) {
      return false;
    }

    try {
      const script = `
        try {
          const sqlite = require('node:sqlite');
          const db = new sqlite.DatabaseSync(${JSON.stringify(cloudDbPath)});
          const account = db.prepare('SELECT id FROM accounts WHERE email = ?').get(${JSON.stringify(email)});
          if (account && account.id) {
            db.prepare('UPDATE accounts SET is_active = 0').run();
            db.prepare('UPDATE accounts SET is_active = 1, last_used = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), account.id);
            const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
            upsert.run('active_cloud_account.classic', JSON.stringify(account.id));
            upsert.run('active_cloud_account.ide', JSON.stringify(account.id));
          }
          db.close();
        } catch(e) {}
      `;
      cp.execFile('node', ['-e', script], () => {});
      return true;
    } catch {
      return false;
    }
  }

  /**
  /**
   * Validates whether an email string is a genuine clean email address
   * and not an internal extension key, phantom token, or system setting.
   */
  public isValidEmail(email?: string): boolean {
    if (!email || typeof email !== 'string') return false;
    const trimmed = email.trim().toLowerCase();
    if (
      trimmed.startsWith('antigravity') ||
      trimmed.includes('secure.') ||
      trimmed.includes('.accesstoken') ||
      trimmed.includes('example.com') ||
      trimmed.includes('codeium') ||
      trimmed.includes('github')
    ) {
      return false;
    }
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return emailRegex.test(trimmed);
  }

  /**
   * Reads the currently signed-in Antigravity IDE account and active token.
   * Prioritizes live in-memory Antigravity Unified State Sync API first,
   * falling back to local state.vscdb structured storage.
   * Returns null if no active session is found (e.g. user is logged out).
   */
  public async getCurrentAntigravityAccount(): Promise<DiscoveredAccount | null> {
    // 1. Prioritize live in-memory Unified State Sync
    try {
      const unifiedSync = (vscode as any).antigravityUnifiedStateSync;
      if (unifiedSync?.OAuthPreferences?.getOAuthTokenInfo) {
        const tokenInfo = await unifiedSync.OAuthPreferences.getOAuthTokenInfo();
        if (tokenInfo?.accessToken) {
          let email = '';
          let name = '';
          if (unifiedSync.UserStatus?.getUserStatus) {
            const rawStatus = await unifiedSync.UserStatus.getUserStatus();
            if (rawStatus) {
              const statusBytes = Buffer.from(rawStatus, 'base64');
              const parsed = this.parseUserStatusBytes(statusBytes);
              email = parsed.email;
              name = parsed.name;
            }
          }
          if (email && this.isValidEmail(email)) {
            return {
              email,
              name: name || email.split('@')[0],
              accessToken: tokenInfo.accessToken,
              refreshToken: tokenInfo.refreshToken
            };
          }
        }
      }
    } catch (e) {
      console.warn('[StorageService] Error reading live account from unifiedStateSync:', e);
    }

    // 2. Fallback to state.vscdb structured query ONLY
    const stateDbPath = path.join(
      os.homedir(),
      'AppData',
      'Roaming',
      'Antigravity IDE',
      'User',
      'globalStorage',
      'state.vscdb'
    );
    if (!fs.existsSync(stateDbPath)) return null;

    try {
      const nativeDb = this.getSqliteDb(stateDbPath);
      if (nativeDb) {
        try {
          const userStatusRow = nativeDb.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravityUnifiedStateSync.userStatus');
          const oauthRow = nativeDb.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravityUnifiedStateSync.oauthToken');
          const authStatusRow = nativeDb.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravityAuthStatus');
          const profRow = nativeDb.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravity.profileUrl');
          nativeDb.close();

          let email = '';
          let name = '';
          let accessToken = '';
          const avatarUrl = profRow?.value || undefined;

          // Check structured uss keys
          if (userStatusRow?.value && oauthRow?.value) {
            const usBytes = Buffer.from(userStatusRow.value, 'base64');
            const { email: parsedEmail, name: parsedName } = this.parseUserStatusBytes(usBytes);
            if (this.isValidEmail(parsedEmail)) {
              const oauthStr = Buffer.from(oauthRow.value, 'base64').toString('latin1');
              const yaMatch = oauthStr.match(/ya29\.[A-Za-z0-9_\-]+/);
              if (yaMatch) {
                email = parsedEmail;
                name = parsedName;
                accessToken = yaMatch[0];
              }
            }
          }

          // Check antigravityAuthStatus row
          if ((!email || !accessToken) && authStatusRow?.value) {
            try {
              const auth = JSON.parse(authStatusRow.value);
              if (auth.email && this.isValidEmail(auth.email) && auth.apiKey?.startsWith('ya29.')) {
                email = auth.email;
                name = auth.name || auth.email.split('@')[0];
                accessToken = auth.apiKey;
              }
            } catch {}
          }

          if (email && accessToken && this.isValidEmail(email)) {
            return {
              email,
              name: name || email.split('@')[0],
              accessToken,
              avatarUrl
            };
          }
        } catch {}
      }
    } catch (err) {
      console.warn('[StorageService] Error getting current Antigravity account:', err);
    }

    return null;
  }

  /**
   * Helper to detect and import previous accounts from existing state.vscdb
   */
  public async discoverExistingAccounts(): Promise<DiscoveredAccount[]> {
    const discovered: Map<string, DiscoveredAccount> = new Map();

    // Only read the currently active Antigravity session from state.vscdb.
    // We do NOT read from third-party extension keys (e.g. Davissss2.antigravity-account)
    // as those contain stale data from other extensions and cause phantom account imports.
    const current = await this.getCurrentAntigravityAccount();
    if (current) {
      discovered.set(current.email, current);
    }

    return Array.from(discovered.values());
  }


  // ── Protobuf Utilities ──

  private encodeVarint(val: number): Uint8Array {
    const bytes: number[] = [];
    let num = BigInt(val);
    while (num >= 128n) {
      bytes.push(Number((num & 127n) | 128n));
      num >>= 7n;
    }
    bytes.push(Number(num));
    return new Uint8Array(bytes);
  }

  private encodeVarintField(fieldNum: number, value: number): Uint8Array {
    const tag = (fieldNum << 3) | 0;
    const tagBytes = this.encodeVarint(tag);
    const valueBytes = this.encodeVarint(value);
    return Buffer.concat([Buffer.from(tagBytes), Buffer.from(valueBytes)]);
  }

  private encodeLenDelimField(fieldNum: number, data: Uint8Array): Uint8Array {
    const tag = (fieldNum << 3) | 2;
    const tagBytes = this.encodeVarint(tag);
    const lenBytes = this.encodeVarint(data.length);
    return Buffer.concat([Buffer.from(tagBytes), Buffer.from(lenBytes), Buffer.from(data)]);
  }

  private encodeStringField(fieldNum: number, value: string): Uint8Array {
    return this.encodeLenDelimField(fieldNum, Buffer.from(value, 'utf8'));
  }

  private createOAuthInfo(
    accessToken: string,
    refreshToken: string,
    expirySeconds: number,
    isGcpTos = false,
    idToken?: string,
    email?: string
  ): Uint8Array {
    if (isGcpTos && email) {
      const lower = email.toLowerCase();
      if (lower.endsWith('@gmail.com') || lower.endsWith('@googlemail.com')) {
        isGcpTos = false;
      }
    }

    const field1 = this.encodeStringField(1, accessToken);
    const field2 = this.encodeStringField(2, 'Bearer');
    const field3 = this.encodeStringField(3, refreshToken);

    const timestampTag = (1 << 3) | 0;
    const tagBytes = this.encodeVarint(timestampTag);
    const secondsBytes = this.encodeVarint(expirySeconds);
    const timestampMsg = Buffer.concat([Buffer.from(tagBytes), Buffer.from(secondsBytes)]);
    const field4 = this.encodeLenDelimField(4, timestampMsg);

    const field5 = idToken ? this.encodeStringField(5, idToken) : new Uint8Array();
    const field6 = isGcpTos ? this.encodeVarintField(6, 1) : new Uint8Array();

    return Buffer.concat([
      Buffer.from(field1),
      Buffer.from(field2),
      Buffer.from(field3),
      Buffer.from(field4),
      Buffer.from(field5),
      Buffer.from(field6)
    ]);
  }

  public parseProtoFields(buf: Uint8Array): Array<{ fieldNum: number; wireType: number; data: bigint | Uint8Array; rawBytes: Uint8Array }> {
    let pos = 0;
    const fields: Array<{ fieldNum: number; wireType: number; data: bigint | Uint8Array; rawBytes: Uint8Array }> = [];
    while (pos < buf.length) {
      const tagStart = pos;
      let tag = 0;
      let shift = 0;
      while (pos < buf.length) {
        const b = buf[pos++];
        tag |= (b & 0x7F) << shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
      }
      const wireType = tag & 7;
      const fieldNum = tag >> 3;
      let data: bigint | Uint8Array = 0n;

      if (wireType === 0) {
        let val = 0n;
        let valShift = 0n;
        while (pos < buf.length) {
          const b = buf[pos++];
          val |= BigInt(b & 0x7F) << valShift;
          valShift += 7n;
          if ((b & 0x80) === 0) break;
        }
        data = val;
      } else if (wireType === 2) {
        let len = 0;
        let lenShift = 0;
        while (pos < buf.length) {
          const b = buf[pos++];
          len |= (b & 0x7F) << lenShift;
          lenShift += 7;
          if ((b & 0x80) === 0) break;
        }
        data = buf.subarray(pos, pos + len);
        pos += len;
      } else if (wireType === 1) {
        data = buf.subarray(pos, pos + 8);
        pos += 8;
      } else if (wireType === 5) {
        data = buf.subarray(pos, pos + 4);
        pos += 4;
      } else {
        break;
      }
      fields.push({ fieldNum, wireType, data, rawBytes: buf.subarray(tagStart, pos) });
    }
    return fields;
  }

  public patchUserStatusPayload(existingBytes: Uint8Array, newEmail: string, newName?: string, newAvatarUrl?: string): Uint8Array {
    const fields = this.parseProtoFields(existingBytes);
    const resultParts: Uint8Array[] = [];
    let hasEmail = false;
    let hasName = false;
    let hasAvatar = false;

    for (const f of fields) {
      if (f.fieldNum === 7) {
        resultParts.push(this.encodeStringField(7, newEmail));
        hasEmail = true;
      } else if (f.fieldNum === 3) {
        resultParts.push(this.encodeStringField(3, newName || newEmail.split('@')[0]));
        hasName = true;
      } else if (f.fieldNum === 26) {
        if (newAvatarUrl) {
          resultParts.push(this.encodeStringField(26, newAvatarUrl));
        } else if (f.wireType === 2 && f.data instanceof Uint8Array) {
          resultParts.push(this.encodeStringField(26, Buffer.from(f.data).toString('utf8')));
        }
        hasAvatar = true;
      } else {
        // PRESERVE ALL OTHER FIELDS (including models, paid tier, permissions, etc.)
        resultParts.push(f.rawBytes);
      }
    }

    if (!hasEmail) {
      resultParts.push(this.encodeStringField(7, newEmail));
    }
    if (!hasName) {
      resultParts.push(this.encodeStringField(3, newName || newEmail.split('@')[0]));
    }
    if (!hasAvatar && newAvatarUrl) {
      resultParts.push(this.encodeStringField(26, newAvatarUrl));
    }

    return Buffer.concat(resultParts.map(p => Buffer.from(p)));
  }

  public patchUnifiedStateSyncTopicUserStatus(
    topicBuf: Uint8Array,
    newEmail: string,
    newName?: string,
    newAvatarUrl?: string
  ): string | null {
    try {
      const topFields = this.parseProtoFields(topicBuf);
      const newEntries: Uint8Array[] = [];
      let found = false;

      for (const f of topFields) {
        if (f.fieldNum === 1 && f.wireType === 2 && f.data instanceof Uint8Array) {
          const entryFields = this.parseProtoFields(f.data);
          const keyField = entryFields.find(e => e.fieldNum === 1);
          const key = keyField && keyField.data instanceof Uint8Array ? Buffer.from(keyField.data).toString('utf8') : '';

          if (key === 'userStatusSentinelKey') {
            const rowField = entryFields.find(e => e.fieldNum === 2);
            if (rowField && rowField.data instanceof Uint8Array) {
              const rowFields = this.parseProtoFields(rowField.data);
              const valField = rowFields.find(r => r.fieldNum === 1);
              if (valField && valField.data instanceof Uint8Array) {
                const innerB64 = Buffer.from(valField.data).toString('utf8');
                const innerBytes = Buffer.from(innerB64, 'base64');
                const patchedBytes = this.patchUserStatusPayload(innerBytes, newEmail, newName, newAvatarUrl);
                const patchedB64 = Buffer.from(patchedBytes).toString('base64');
                const newRow = this.encodeStringField(1, patchedB64);
                const newEntry = Buffer.concat([
                  Buffer.from(this.encodeStringField(1, 'userStatusSentinelKey')),
                  Buffer.from(this.encodeLenDelimField(2, newRow))
                ]);
                newEntries.push(this.encodeLenDelimField(1, newEntry));
                found = true;
                continue;
              }
            }
          }
          newEntries.push(this.encodeLenDelimField(1, f.data));
        }
      }

      if (found) {
        return Buffer.concat(newEntries.map(e => Buffer.from(e))).toString('base64');
      }
    } catch (e) {
      console.warn('[Antigravity Swap] patchUnifiedStateSyncTopicUserStatus error:', e);
    }
    return null;
  }

  public createDataEntry(sentinelKey: string, valueStr: string): Uint8Array {
    const row = this.encodeStringField(1, valueStr);
    return Buffer.concat([
      Buffer.from(this.encodeStringField(1, sentinelKey)),
      Buffer.from(this.encodeLenDelimField(2, row))
    ]);
  }

  private createUnifiedStateEntry(sentinelKey: string, payload: Uint8Array): string {
    const payloadBase64 = Buffer.from(payload).toString('base64');
    const dataEntry = this.createDataEntry(sentinelKey, payloadBase64);
    const topic = this.encodeLenDelimField(1, dataEntry);
    return Buffer.from(topic).toString('base64');
  }

  private createUnifiedOAuthToken(
    accessToken: string,
    refreshToken: string,
    expirySeconds: number,
    isGcpTos = false,
    idToken?: string,
    email?: string
  ): string {
    if (isGcpTos && email) {
      const lower = email.toLowerCase();
      if (lower.endsWith('@gmail.com') || lower.endsWith('@googlemail.com')) {
        isGcpTos = false;
      }
    }
    const oauthInfo = this.createOAuthInfo(accessToken, refreshToken, expirySeconds, isGcpTos, idToken, email);
    const oauthB64 = Buffer.from(oauthInfo).toString('base64');
    const entry1 = this.createDataEntry('oauthTokenInfoSentinelKey', oauthB64);

    const authStateJson = JSON.stringify({
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
    const entry2 = this.createDataEntry('authStateWithContextSentinelKey', authStateJson);

    const topicMsg = Buffer.concat([
      Buffer.from(this.encodeLenDelimField(1, entry1)),
      Buffer.from(this.encodeLenDelimField(1, entry2))
    ]);
    return Buffer.from(topicMsg).toString('base64');
  }

  public createUserStatusPayload(email: string, name?: string): Uint8Array {
    const field1 = this.encodeVarintField(1, 1); // pro: true
    const field3 = this.encodeStringField(3, name || email.split('@')[0]); // name
    const field7 = this.encodeStringField(7, email); // email
    const field31 = this.encodeVarintField(31, 1); // has_used_antigravity: true
    const field34 = this.encodeVarintField(34, 1); // accepted_latest_terms_of_service: true
    return Buffer.concat([
      Buffer.from(field1),
      Buffer.from(field3),
      Buffer.from(field7),
      Buffer.from(field31),
      Buffer.from(field34)
    ]);
  }

  public createUnifiedUserStatus(email: string, name?: string): string {
    const userStatusPayload = this.createUserStatusPayload(email, name);
    return this.createUnifiedStateEntry('userStatusSentinelKey', userStatusPayload);
  }

  public createSerializedUpdateRequest(topicName: string, sentinelKey: string, innerPayloadBytes: Uint8Array): string {
    const innerBase64 = Buffer.from(innerPayloadBytes).toString('base64');
    const rowMsg = this.encodeStringField(1, innerBase64);
    const appliedUpdateMsg = Buffer.concat([
      Buffer.from(this.encodeStringField(1, sentinelKey)),
      Buffer.from(this.encodeLenDelimField(2, rowMsg))
    ]);
    const updateRequestMsg = Buffer.concat([
      Buffer.from(this.encodeStringField(1, topicName)),
      Buffer.from(this.encodeLenDelimField(5, appliedUpdateMsg))
    ]);
    return Buffer.from(updateRequestMsg).toString('base64');
  }

  public parseUserStatusBytes(bytes: Uint8Array): { email: string; name: string } {
    let email = '';
    let name = '';
    let pos = 0;
    while (pos < bytes.length) {
      let tag = 0;
      let shift = 0;
      while (pos < bytes.length) {
        const b = bytes[pos++];
        tag |= (b & 0x7F) << shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
      }
      const wireType = tag & 7;
      const fieldNum = tag >> 3;

      if (wireType === 0) {
        while (pos < bytes.length && (bytes[pos++] & 0x80) !== 0) {}
      } else if (wireType === 2) {
        let len = 0;
        let lenShift = 0;
        while (pos < bytes.length) {
          const b = bytes[pos++];
          len |= (b & 0x7F) << lenShift;
          lenShift += 7;
          if ((b & 0x80) === 0) break;
        }
        if (pos + len <= bytes.length) {
          const strBytes = bytes.subarray(pos, pos + len);
          if (fieldNum === 7) {
            email = Buffer.from(strBytes).toString('utf8');
          } else if (fieldNum === 3) {
            name = Buffer.from(strBytes).toString('utf8');
          }
        }
        pos += len;
      } else if (wireType === 1) {
        pos += 8;
      } else if (wireType === 5) {
        pos += 4;
      } else {
        break;
      }
    }
    return { email, name };
  }
}
