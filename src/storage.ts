import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as cp from 'child_process';
import { AccountInfo, OAuthTokens } from './types';

export interface DiscoveredAccount {
  email: string;
  name: string;
  avatarUrl?: string;
  accessToken?: string;
  refreshToken?: string;
}

export class StorageService {
  private static readonly ACCOUNTS_KEY = 'antigravitySwap.accounts';
  private static readonly ACTIVE_ACCOUNT_KEY = 'antigravitySwap.activeEmail';
  private static readonly AUTO_SWITCH_KEY = 'antigravitySwap.autoSwitch';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly secrets: vscode.SecretStorage
  ) {}

  public getAccounts(): AccountInfo[] {
    return this.context.globalState.get<AccountInfo[]>(StorageService.ACCOUNTS_KEY, []);
  }

  public async saveAccounts(accounts: AccountInfo[]): Promise<void> {
    await this.context.globalState.update(StorageService.ACCOUNTS_KEY, accounts);
  }

  public getActiveAccountEmail(): string | undefined {
    return this.context.globalState.get<string>(StorageService.ACTIVE_ACCOUNT_KEY);
  }

  public async setActiveAccountEmail(email: string | undefined): Promise<void> {
    await this.context.globalState.update(StorageService.ACTIVE_ACCOUNT_KEY, email);
  }

  public getAutoSwitchEnabled(): boolean {
    return this.context.globalState.get<boolean>(StorageService.AUTO_SWITCH_KEY, true);
  }

  public async setAutoSwitchEnabled(enabled: boolean): Promise<void> {
    await this.context.globalState.update(StorageService.AUTO_SWITCH_KEY, enabled);
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
   * Updates the running Language Server and AI Agent in place WITHOUT closing or restarting the IDE.
   */
  public async liveSwitchOAuthToken(account: AccountInfo, tokens: OAuthTokens): Promise<boolean> {
    try {
      const unifiedSync = (vscode as any).antigravityUnifiedStateSync;
      if (unifiedSync && unifiedSync.OAuthPreferences && typeof unifiedSync.OAuthPreferences.setOAuthTokenInfo === 'function') {
        const isGcpTos = !account.email.toLowerCase().endsWith('@gmail.com') && !account.email.toLowerCase().endsWith('@googlemail.com');
        await unifiedSync.OAuthPreferences.setOAuthTokenInfo({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken || '',
          expiryDateSeconds: Math.floor((tokens.expiresAt || Date.now() + 3600000) / 1000),
          tokenType: 'Bearer',
          isGcpTos: isGcpTos
        });
        console.log('[Antigravity Swap] Successfully hot-switched OAuth token via antigravityUnifiedStateSync!');
        return true;
      }
    } catch (err) {
      console.warn('[Antigravity Swap] liveSwitchOAuthToken warning:', err);
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

      const userStatusPayload = this.createMinimalUserStatusPayload(account.email);
      const unifiedUserStatus = this.createUnifiedStateEntry('userStatusSentinelKey', userStatusPayload);

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

      const rows: Array<{ key: string; value: string | null }> = [
        { key: 'antigravityAuthStatus', value: authStatus },
        { key: 'antigravityUnifiedStateSync.oauthToken', value: unifiedOAuth },
        { key: 'antigravityUnifiedStateSync.userStatus', value: unifiedUserStatus },
        { key: 'antigravityOnboarding', value: 'true' },
        { key: 'antigravitySwap.activeEmail', value: account.email },
        { key: 'antigravity-community.antigravity-swap', value: extensionStateValue }
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
   * Directly updates Antigravity IDE global state database so the internal IDE runtime
   * immediately synchronizes credentials.
   */
  public async syncToIdeStateDb(account: AccountInfo, tokens: OAuthTokens): Promise<boolean> {
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
      // 1. Update antigravityAuthStatus (JSON)
      const authStatus = JSON.stringify({
        name: account.name || account.email.split('@')[0],
        email: account.email,
        apiKey: tokens.accessToken
      });
      await this.execSqliteUpsert(stateDbPath, 'antigravityAuthStatus', authStatus);

      // 2. Update antigravityUnifiedStateSync.oauthToken (Protobuf)
      if (tokens.accessToken) {
        const unifiedOAuth = this.createUnifiedOAuthToken(
          tokens.accessToken,
          tokens.refreshToken || '',
          Math.floor((tokens.expiresAt || Date.now() + 3600000) / 1000),
          false,
          undefined,
          account.email
        );
        await this.execSqliteUpsert(stateDbPath, 'antigravityUnifiedStateSync.oauthToken', unifiedOAuth);

        // 3. Update antigravityUnifiedStateSync.userStatus (Protobuf)
        const userStatusPayload = this.createMinimalUserStatusPayload(account.email);
        const unifiedUserStatus = this.createUnifiedStateEntry('userStatusSentinelKey', userStatusPayload);
        await this.execSqliteUpsert(stateDbPath, 'antigravityUnifiedStateSync.userStatus', unifiedUserStatus);
      }

      // 4. Update onboarding status
      await this.execSqliteUpsert(stateDbPath, 'antigravityOnboarding', 'true');

      // 5. Update profile picture if available
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
   * Reads the currently signed-in Antigravity IDE account and active token from state.vscdb
   * using zero-dependency binary parsing.
   */
  public async getCurrentAntigravityAccount(): Promise<DiscoveredAccount | null> {
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
      const buf = fs.readFileSync(stateDbPath);
      const str = buf.toString('latin1');

      let email = '';
      let name = '';
      let accessToken = '';
      let avatarUrl: string | undefined;

      // 1. Search for antigravityAuthStatus JSON
      let idx = 0;
      while ((idx = str.indexOf('antigravityAuthStatus', idx)) !== -1) {
        const snippet = str.substring(idx + 'antigravityAuthStatus'.length, idx + 'antigravityAuthStatus'.length + 8000);
        const jsonStart = snippet.search(/[{\[]/);
        if (jsonStart !== -1 && jsonStart < 100) {
          let depth = 0;
          let inString = false;
          let escape = false;
          const startChar = snippet[jsonStart];
          const endChar = startChar === '{' ? '}' : ']';

          for (let i = jsonStart; i < snippet.length; i++) {
            const c = snippet[i];
            if (escape) { escape = false; continue; }
            if (c === '\\') { escape = true; continue; }
            if (c === '"') { inString = !inString; continue; }
            if (!inString) {
              if (c === startChar) depth++;
              else if (c === endChar) {
                depth--;
                if (depth === 0) {
                  try {
                    const parsed = JSON.parse(snippet.substring(jsonStart, i + 1));
                    if (parsed.email && parsed.apiKey) {
                      email = parsed.email;
                      name = parsed.name || parsed.email.split('@')[0];
                      accessToken = parsed.apiKey;
                    }
                  } catch {}
                  break;
                }
              }
            }
          }
        }
        idx += 'antigravityAuthStatus'.length;
      }

      // 2. Search profileUrl
      const profIdx = str.lastIndexOf('antigravity.profileUrl');
      if (profIdx !== -1) {
        const profSnippet = str.substring(profIdx, profIdx + 500);
        const match = profSnippet.match(/https?:\/\/[^\s\x00-\x1F"']+/);
        if (match) avatarUrl = match[0];
      }

      if (email && accessToken) {
        return { email, name: name || email.split('@')[0], accessToken, avatarUrl };
      }
      return null;
    } catch (err) {
      console.warn('[StorageService] Error getting current Antigravity account:', err);
      return null;
    }
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

  private createUnifiedStateEntry(sentinelKey: string, payload: Uint8Array): string {
    const payloadBase64 = Buffer.from(payload).toString('base64');
    const row = this.encodeStringField(1, payloadBase64);
    const dataEntry = Buffer.concat([
      Buffer.from(this.encodeStringField(1, sentinelKey)),
      Buffer.from(this.encodeLenDelimField(2, row))
    ]);
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
    const oauthInfo = this.createOAuthInfo(accessToken, refreshToken, expirySeconds, isGcpTos, idToken, email);
    return this.createUnifiedStateEntry('oauthTokenInfoSentinelKey', oauthInfo);
  }

  private createMinimalUserStatusPayload(email: string): Uint8Array {
    return Buffer.concat([
      Buffer.from(this.encodeStringField(3, email)),
      Buffer.from(this.encodeStringField(7, email))
    ]);
  }
}
