import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as cp from 'child_process';
import { AccountInfo, OAuthTokens } from '../types';
import { createUnifiedOAuthToken, patchUnifiedStateSyncTopicUserStatus } from './protoUtils';

export class IdeStateDbService {
  public getSqliteDb(dbPath: string): any {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sqliteModule = (globalThis as any).require ? (globalThis as any).require('node:sqlite') : require('node:sqlite');
      if (sqliteModule && sqliteModule.DatabaseSync) {
        return new sqliteModule.DatabaseSync(dbPath);
      }
    } catch {}
    return null;
  }

  public async execSqliteUpsert(dbPath: string, key: string, value: string): Promise<boolean> {
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

      const unifiedOAuth = createUnifiedOAuthToken(
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
            patchedUserStatusTopic = patchUnifiedStateSyncTopicUserStatus(
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

  public getWorkerScriptContent(): string {
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
          if (pid && pid !== ownPid && parts[1].toLowerCase().includes('antigravity')) {
            pids.push(pid);
          }
        }
      }
    }
  } catch (e) {}
  return pids;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForIdeToExit(maxWaitMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const pids = getOtherAntigravityPids();
    if (pids.length === 0) return true;
    await sleep(400);
  }
  return false;
}

function updateDatabase() {
  let db;
  try {
    const sqlite = require('node:sqlite');
    db = new sqlite.DatabaseSync(dbPath);
  } catch (e) {
    return false;
  }

  try {
    const upsertStmt = db.prepare(
      'INSERT INTO ItemTable (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    const deleteStmt = db.prepare('DELETE FROM ItemTable WHERE key = ?');

    for (const r of rows) {
      if (r.value === null) {
        deleteStmt.run(r.key);
      } else {
        upsertStmt.run(r.key, r.value);
      }
    }
    db.close();
    return true;
  } catch (e) {
    try { db.close(); } catch (_) {}
    return false;
  }
}

function findRelaunchExe() {
  for (const c of exeCandidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return process.execPath;
}

async function main() {
  await waitForIdeToExit();
  await sleep(600);

  updateDatabase();

  try { fs.unlinkSync(payloadPath); } catch (_) {}
  try { fs.unlinkSync(process.argv[1]); } catch (_) {}

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
  public async syncToIdeStateDb(account: AccountInfo, tokens: OAuthTokens, _skipUssKeys = false): Promise<boolean> {
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
        const unifiedOAuth = createUnifiedOAuthToken(
          tokens.accessToken,
          tokens.refreshToken || '',
          Math.floor((tokens.expiresAt || Date.now() + 3600000) / 1000),
          false,
          undefined,
          account.email
        );
        await this.execSqliteUpsert(stateDbPath, 'antigravityUnifiedStateSync.oauthToken', unifiedOAuth);

        // 2. Handle antigravityUnifiedStateSync.userStatus safely:
        try {
          const nativeDb = this.getSqliteDb(stateDbPath);
          if (nativeDb) {
            const existingRow = nativeDb.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravityUnifiedStateSync.userStatus');
            if (existingRow && existingRow.value) {
              if (existingRow.value.length > 250) {
                const topicBuf = Buffer.from(existingRow.value, 'base64');
                const patchedTopic = patchUnifiedStateSyncTopicUserStatus(topicBuf, account.email, account.name, account.avatarUrl);
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
}
