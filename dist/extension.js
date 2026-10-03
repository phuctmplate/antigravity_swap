"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode7 = __toESM(require("vscode"));

// src/storage.ts
var vscode = __toESM(require("vscode"));
var path = __toESM(require("path"));
var os = __toESM(require("os"));
var fs = __toESM(require("fs"));
var cp = __toESM(require("child_process"));
var StorageService = class _StorageService {
  constructor(context, secrets) {
    this.context = context;
    this.secrets = secrets;
  }
  static ACCOUNTS_KEY = "antigravitySwap.accounts";
  static ACTIVE_ACCOUNT_KEY = "antigravitySwap.activeEmail";
  static AUTO_SWITCH_KEY = "antigravitySwap.autoSwitch";
  getAccounts() {
    return this.context.globalState.get(_StorageService.ACCOUNTS_KEY, []);
  }
  async saveAccounts(accounts) {
    await this.context.globalState.update(_StorageService.ACCOUNTS_KEY, accounts);
  }
  getActiveAccountEmail() {
    return this.context.globalState.get(_StorageService.ACTIVE_ACCOUNT_KEY);
  }
  async setActiveAccountEmail(email) {
    await this.context.globalState.update(_StorageService.ACTIVE_ACCOUNT_KEY, email);
  }
  getAutoSwitchEnabled() {
    return this.context.globalState.get(_StorageService.AUTO_SWITCH_KEY, true);
  }
  async setAutoSwitchEnabled(enabled) {
    await this.context.globalState.update(_StorageService.AUTO_SWITCH_KEY, enabled);
  }
  async getAccountTokens(email) {
    const raw = await this.secrets.get(`antigravitySwap.tokens.${email}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  async saveAccountTokens(email, tokens) {
    await this.secrets.store(`antigravitySwap.tokens.${email}`, JSON.stringify(tokens));
  }
  async removeAccountTokens(email) {
    await this.secrets.delete(`antigravitySwap.tokens.${email}`);
  }
  getSqliteDb(dbPath) {
    try {
      const sqliteModule = globalThis.require ? globalThis.require("node:sqlite") : require("node:sqlite");
      if (sqliteModule && sqliteModule.DatabaseSync) {
        return new sqliteModule.DatabaseSync(dbPath);
      }
    } catch {
    }
    return null;
  }
  async execSqliteUpsert(dbPath, key, value) {
    const nativeDb = this.getSqliteDb(dbPath);
    if (nativeDb) {
      try {
        const upsert = nativeDb.prepare(
          "INSERT INTO ItemTable (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        );
        upsert.run(key, value);
        nativeDb.close();
        return true;
      } catch (e) {
        console.warn("Native sqlite upsert failed:", e);
      }
    }
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
      cp.execFile("node", ["-e", script], (err) => {
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
  async liveSwitchOAuthToken(account, tokens) {
    try {
      const unifiedSync = vscode.antigravityUnifiedStateSync;
      if (unifiedSync && unifiedSync.OAuthPreferences && typeof unifiedSync.OAuthPreferences.setOAuthTokenInfo === "function") {
        const isGcpTos = !account.email.toLowerCase().endsWith("@gmail.com") && !account.email.toLowerCase().endsWith("@googlemail.com");
        await unifiedSync.OAuthPreferences.setOAuthTokenInfo({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken || "",
          expiryDateSeconds: Math.floor((tokens.expiresAt || Date.now() + 36e5) / 1e3),
          tokenType: "Bearer",
          isGcpTos
        });
        console.log("[Antigravity Swap] Successfully hot-switched OAuth token via antigravityUnifiedStateSync!");
        return true;
      }
    } catch (err) {
      console.warn("[Antigravity Swap] liveSwitchOAuthToken warning:", err);
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
  async injectAccountStateAndRelaunch(account, tokens, allAccounts) {
    const stateDbPath = path.join(
      os.homedir(),
      "AppData",
      "Roaming",
      "Antigravity IDE",
      "User",
      "globalStorage",
      "state.vscdb"
    );
    if (!fs.existsSync(stateDbPath)) {
      vscode.window.showErrorMessage("Antigravity IDE state database not found.");
      return false;
    }
    try {
      const authStatus = JSON.stringify({
        name: account.name || account.email.split("@")[0],
        email: account.email,
        apiKey: tokens.accessToken
      });
      const unifiedOAuth = this.createUnifiedOAuthToken(
        tokens.accessToken,
        tokens.refreshToken || "",
        Math.floor((tokens.expiresAt || Date.now() + 36e5) / 1e3),
        false,
        void 0,
        account.email
      );
      const userStatusPayload = this.createMinimalUserStatusPayload(account.email);
      const unifiedUserStatus = this.createUnifiedStateEntry("userStatusSentinelKey", userStatusPayload);
      const updatedAccounts = allAccounts.map((a) => ({
        ...a,
        isActive: a.email === account.email,
        lastUsedAt: a.email === account.email ? (/* @__PURE__ */ new Date()).toISOString() : a.lastUsedAt
      }));
      const extensionStateValue = JSON.stringify({
        "antigravitySwap.accounts": updatedAccounts,
        "antigravitySwap.activeEmail": account.email
      });
      const rows = [
        { key: "antigravityAuthStatus", value: authStatus },
        { key: "antigravityUnifiedStateSync.oauthToken", value: unifiedOAuth },
        { key: "antigravityUnifiedStateSync.userStatus", value: unifiedUserStatus },
        { key: "antigravityOnboarding", value: "true" },
        { key: "antigravitySwap.activeEmail", value: account.email },
        { key: "antigravity-community.antigravity-swap", value: extensionStateValue }
      ];
      if (account.avatarUrl) {
        rows.push({ key: "antigravity.profileUrl", value: account.avatarUrl });
      }
      const currentExe = process.execPath;
      const candidatePaths = [
        currentExe,
        path.join(process.env.LOCALAPPDATA || "", "Programs", "Antigravity IDE", "Antigravity IDE.exe"),
        path.join(process.env.LOCALAPPDATA || "", "Programs", "Antigravity", "Antigravity.exe"),
        path.join(os.homedir(), "AppData", "Local", "Programs", "Antigravity IDE", "Antigravity IDE.exe")
      ].filter((p, i, arr) => p && arr.indexOf(p) === i && fs.existsSync(p));
      const workDir = path.join(os.homedir(), ".antigravity-swap");
      if (!fs.existsSync(workDir)) {
        fs.mkdirSync(workDir, { recursive: true });
      }
      const payloadPath = path.join(workDir, ".inject-payload.json");
      const workerPath = path.join(workDir, ".inject-worker.js");
      const workspaceFolders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];
      const payloadObj = {
        dbPath: stateDbPath,
        rows,
        exeCandidates: candidatePaths,
        workspacePaths: workspaceFolders
      };
      fs.writeFileSync(payloadPath, JSON.stringify(payloadObj, null, 2), "utf-8");
      fs.writeFileSync(workerPath, this.getWorkerScriptContent(), "utf-8");
      const workerEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
      const child = cp.spawn(currentExe, [workerPath, payloadPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        cwd: workDir,
        env: workerEnv
      });
      child.unref();
      console.log(`[Antigravity Swap] Detached inject worker spawned (PID: ${child.pid}). Closing window to flush & restart...`);
      await vscode.commands.executeCommand("workbench.action.closeWindow");
      return true;
    } catch (err) {
      console.error("[Antigravity Swap] Failed to launch injection worker:", err);
      vscode.window.showErrorMessage(`Switch failed: ${err.message}`);
      return false;
    }
  }
  getWorkerScriptContent() {
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
          execSync('powershell -NoProfile -Command "Remove-Item Env:ELECTRON_RUN_AS_NODE -EA SilentlyContinue; Start-Process \\"' + relaunchExe + '\\" -ArgumentList \\"' + wsArg.trim() + '\\""', { stdio: 'ignore', windowsHide: true });
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
  async syncToIdeStateDb(account, tokens) {
    const stateDbPath = path.join(
      os.homedir(),
      "AppData",
      "Roaming",
      "Antigravity IDE",
      "User",
      "globalStorage",
      "state.vscdb"
    );
    if (!fs.existsSync(stateDbPath)) {
      return false;
    }
    try {
      const authStatus = JSON.stringify({
        name: account.name || account.email.split("@")[0],
        email: account.email,
        apiKey: tokens.accessToken
      });
      await this.execSqliteUpsert(stateDbPath, "antigravityAuthStatus", authStatus);
      if (tokens.accessToken) {
        const unifiedOAuth = this.createUnifiedOAuthToken(
          tokens.accessToken,
          tokens.refreshToken || "",
          Math.floor((tokens.expiresAt || Date.now() + 36e5) / 1e3),
          false,
          void 0,
          account.email
        );
        await this.execSqliteUpsert(stateDbPath, "antigravityUnifiedStateSync.oauthToken", unifiedOAuth);
        const userStatusPayload = this.createMinimalUserStatusPayload(account.email);
        const unifiedUserStatus = this.createUnifiedStateEntry("userStatusSentinelKey", userStatusPayload);
        await this.execSqliteUpsert(stateDbPath, "antigravityUnifiedStateSync.userStatus", unifiedUserStatus);
      }
      await this.execSqliteUpsert(stateDbPath, "antigravityOnboarding", "true");
      if (account.avatarUrl) {
        await this.execSqliteUpsert(stateDbPath, "antigravity.profileUrl", account.avatarUrl);
      }
      return true;
    } catch (err) {
      console.error("[Antigravity Swap] Failed to direct sync state.vscdb:", err);
      return false;
    }
  }
  /**
   * Syncs active account to .antigravity-agent/cloud_accounts.db if the background agent exists.
   */
  async syncToCloudAccountsDb(email) {
    const cloudDbPath = path.join(os.homedir(), ".antigravity-agent", "cloud_accounts.db");
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
      cp.execFile("node", ["-e", script], () => {
      });
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Reads the currently signed-in Antigravity IDE account and active token from state.vscdb
   * using zero-dependency binary parsing.
   */
  async getCurrentAntigravityAccount() {
    const stateDbPath = path.join(
      os.homedir(),
      "AppData",
      "Roaming",
      "Antigravity IDE",
      "User",
      "globalStorage",
      "state.vscdb"
    );
    if (!fs.existsSync(stateDbPath)) return null;
    try {
      const buf = fs.readFileSync(stateDbPath);
      const str = buf.toString("latin1");
      let email = "";
      let name = "";
      let accessToken = "";
      let avatarUrl;
      let idx = 0;
      while ((idx = str.indexOf("antigravityAuthStatus", idx)) !== -1) {
        const snippet = str.substring(idx + "antigravityAuthStatus".length, idx + "antigravityAuthStatus".length + 8e3);
        const jsonStart = snippet.search(/[{\[]/);
        if (jsonStart !== -1 && jsonStart < 100) {
          let depth = 0;
          let inString = false;
          let escape = false;
          const startChar = snippet[jsonStart];
          const endChar = startChar === "{" ? "}" : "]";
          for (let i = jsonStart; i < snippet.length; i++) {
            const c = snippet[i];
            if (escape) {
              escape = false;
              continue;
            }
            if (c === "\\") {
              escape = true;
              continue;
            }
            if (c === '"') {
              inString = !inString;
              continue;
            }
            if (!inString) {
              if (c === startChar) depth++;
              else if (c === endChar) {
                depth--;
                if (depth === 0) {
                  try {
                    const parsed = JSON.parse(snippet.substring(jsonStart, i + 1));
                    if (parsed.email && parsed.apiKey) {
                      email = parsed.email;
                      name = parsed.name || parsed.email.split("@")[0];
                      accessToken = parsed.apiKey;
                    }
                  } catch {
                  }
                  break;
                }
              }
            }
          }
        }
        idx += "antigravityAuthStatus".length;
      }
      const profIdx = str.lastIndexOf("antigravity.profileUrl");
      if (profIdx !== -1) {
        const profSnippet = str.substring(profIdx, profIdx + 500);
        const match = profSnippet.match(/https?:\/\/[^\s\x00-\x1F"']+/);
        if (match) avatarUrl = match[0];
      }
      if (email && accessToken) {
        return { email, name: name || email.split("@")[0], accessToken, avatarUrl };
      }
      return null;
    } catch (err) {
      console.warn("[StorageService] Error getting current Antigravity account:", err);
      return null;
    }
  }
  /**
   * Helper to detect and import previous accounts from existing state.vscdb
   */
  async discoverExistingAccounts() {
    const discovered = /* @__PURE__ */ new Map();
    const current = await this.getCurrentAntigravityAccount();
    if (current) {
      discovered.set(current.email, current);
    }
    return Array.from(discovered.values());
  }
  // ── Protobuf Utilities ──
  encodeVarint(val) {
    const bytes = [];
    let num = BigInt(val);
    while (num >= 128n) {
      bytes.push(Number(num & 127n | 128n));
      num >>= 7n;
    }
    bytes.push(Number(num));
    return new Uint8Array(bytes);
  }
  encodeVarintField(fieldNum, value) {
    const tag = fieldNum << 3 | 0;
    const tagBytes = this.encodeVarint(tag);
    const valueBytes = this.encodeVarint(value);
    return Buffer.concat([Buffer.from(tagBytes), Buffer.from(valueBytes)]);
  }
  encodeLenDelimField(fieldNum, data) {
    const tag = fieldNum << 3 | 2;
    const tagBytes = this.encodeVarint(tag);
    const lenBytes = this.encodeVarint(data.length);
    return Buffer.concat([Buffer.from(tagBytes), Buffer.from(lenBytes), Buffer.from(data)]);
  }
  encodeStringField(fieldNum, value) {
    return this.encodeLenDelimField(fieldNum, Buffer.from(value, "utf8"));
  }
  createOAuthInfo(accessToken, refreshToken, expirySeconds, isGcpTos = false, idToken, email) {
    if (isGcpTos && email) {
      const lower = email.toLowerCase();
      if (lower.endsWith("@gmail.com") || lower.endsWith("@googlemail.com")) {
        isGcpTos = false;
      }
    }
    const field1 = this.encodeStringField(1, accessToken);
    const field2 = this.encodeStringField(2, "Bearer");
    const field3 = this.encodeStringField(3, refreshToken);
    const timestampTag = 1 << 3 | 0;
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
  createUnifiedStateEntry(sentinelKey, payload) {
    const payloadBase64 = Buffer.from(payload).toString("base64");
    const row = this.encodeStringField(1, payloadBase64);
    const dataEntry = Buffer.concat([
      Buffer.from(this.encodeStringField(1, sentinelKey)),
      Buffer.from(this.encodeLenDelimField(2, row))
    ]);
    const topic = this.encodeLenDelimField(1, dataEntry);
    return Buffer.from(topic).toString("base64");
  }
  createUnifiedOAuthToken(accessToken, refreshToken, expirySeconds, isGcpTos = false, idToken, email) {
    const oauthInfo = this.createOAuthInfo(accessToken, refreshToken, expirySeconds, isGcpTos, idToken, email);
    return this.createUnifiedStateEntry("oauthTokenInfoSentinelKey", oauthInfo);
  }
  createMinimalUserStatusPayload(email) {
    return Buffer.concat([
      Buffer.from(this.encodeStringField(3, email)),
      Buffer.from(this.encodeStringField(7, email))
    ]);
  }
};

// src/oauthService.ts
var http = __toESM(require("http"));
var https = __toESM(require("https"));
var url = __toESM(require("url"));
var crypto = __toESM(require("crypto"));
var vscode2 = __toESM(require("vscode"));
var OAuthService = class _OAuthService {
  static CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
  static CLIENT_SECRET = "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";
  static PORTS = [8888, 8889, 8890, 8891, 8892, 45213];
  static REDIRECT_PATH = "/oauth-callback";
  static SCOPES = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs"
  ];
  /**
   * Signs in a Google account via browser OAuth flow.
   */
  async loginWithGoogle(loginHint) {
    return this.startOAuthServerFlow(loginHint);
  }
  /**
   * Starts local HTTP callback server on first available port and initiates Google OAuth in browser.
   */
  async startOAuthServerFlow(loginHint) {
    const { server, port } = await this.bindAvailableServer(_OAuthService.PORTS, 0);
    const redirectUri = `http://127.0.0.1:${port}${_OAuthService.REDIRECT_PATH}`;
    const state = crypto.randomBytes(16).toString("hex");
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", _OAuthService.CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", _OAuthService.SCOPES.join(" "));
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent select_account");
    authUrl.searchParams.set("state", state);
    if (loginHint) {
      authUrl.searchParams.set("login_hint", loginHint);
    }
    return new Promise((resolve, reject) => {
      let activeServer = server;
      const timeoutId = setTimeout(() => {
        if (activeServer) {
          activeServer.close();
          activeServer = null;
        }
        reject(new Error("Google login timed out after 3 minutes."));
      }, 18e4);
      const cleanup = () => {
        clearTimeout(timeoutId);
        if (activeServer) {
          activeServer.close();
          activeServer = null;
        }
      };
      activeServer.on("request", async (req, res) => {
        try {
          const reqUrl = url.parse(req.url || "", true);
          if (reqUrl.pathname === _OAuthService.REDIRECT_PATH) {
            const queryState = reqUrl.query.state;
            const code = reqUrl.query.code;
            const error = reqUrl.query.error;
            if (error) {
              res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
              res.end(this.getHtmlResponse("Authentication Failed", error, false));
              cleanup();
              reject(new Error(`OAuth Error: ${error}`));
              return;
            }
            if (queryState !== state || !code) {
              res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
              res.end(this.getHtmlResponse("Invalid State", "OAuth state verification failed.", false));
              cleanup();
              reject(new Error("Invalid OAuth state parameter"));
              return;
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(this.getHtmlResponse("Account Connected!", "Returning to Antigravity IDE...", true));
            cleanup();
            try {
              const tokens = await this.exchangeCodeForTokens(code, redirectUri);
              const userInfo = await this.fetchUserInfo(tokens.accessToken);
              resolve({ tokens, userInfo });
            } catch (exchangeErr) {
              reject(exchangeErr);
            }
          } else {
            res.writeHead(404);
            res.end();
          }
        } catch (e) {
          cleanup();
          reject(e);
        }
      });
      vscode2.env.openExternal(vscode2.Uri.parse(authUrl.toString()));
    });
  }
  bindAvailableServer(ports, index) {
    return new Promise((resolve, reject) => {
      if (index >= ports.length) {
        return reject(new Error("No available local ports for OAuth callback (tried " + ports.join(", ") + ")"));
      }
      const port = ports[index];
      const srv = http.createServer();
      srv.once("error", (err) => {
        if (err.code === "EADDRINUSE") {
          resolve(this.bindAvailableServer(ports, index + 1));
        } else {
          reject(err);
        }
      });
      srv.listen(port, "127.0.0.1", () => {
        srv.removeAllListeners("error");
        resolve({ server: srv, port });
      });
    });
  }
  getHtmlResponse(title, message, isSuccess) {
    const color = isSuccess ? "#38bdf8" : "#ef4444";
    const uriScheme = vscode2.env?.uriScheme || "vscode";
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Antigravity Swap Authentication</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0b0f1a;
      color: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .card {
      background: #141b2d;
      padding: 40px;
      border-radius: 16px;
      text-align: center;
      border: 1px solid rgba(56, 189, 248, 0.25);
      box-shadow: 0 12px 36px rgba(0,0,0,0.5);
      max-width: 420px;
    }
    h1 { color: ${color}; font-size: 22px; margin-bottom: 8px; }
    p { color: #94a3b8; font-size: 14px; margin-bottom: 24px; }
    .btn {
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      color: #fff;
      border: none;
      padding: 10px 22px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
    <button class="btn" onclick="closeTab()">Return to Antigravity IDE</button>
  </div>
  <script>
    function closeTab() {
      try { window.location.href = "${uriScheme}://"; } catch (e) {}
      setTimeout(() => { try { window.close(); } catch (e) {} }, 500);
    }
    if (${isSuccess}) {
      setTimeout(closeTab, 1200);
    }
  </script>
</body>
</html>`;
  }
  /**
   * Exchanges authorization code for access and refresh tokens.
   */
  async exchangeCodeForTokens(code, redirectUri) {
    const postData = new URLSearchParams({
      client_id: _OAuthService.CLIENT_ID,
      client_secret: _OAuthService.CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    }).toString();
    const response = await this.httpsPost("oauth2.googleapis.com", "/token", postData, {
      "Content-Type": "application/x-www-form-urlencoded"
    });
    const parsed = JSON.parse(response);
    if (parsed.error) {
      throw new Error(`Token exchange failed: ${parsed.error_description || parsed.error}`);
    }
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresAt: Date.now() + (parsed.expires_in || 3600) * 1e3,
      tokenType: parsed.token_type || "Bearer"
    };
  }
  /**
   * Refreshes an expired access token using the account's refresh token.
   */
  async refreshAccessToken(refreshToken) {
    const postData = new URLSearchParams({
      client_id: _OAuthService.CLIENT_ID,
      client_secret: _OAuthService.CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }).toString();
    const response = await this.httpsPost("oauth2.googleapis.com", "/token", postData, {
      "Content-Type": "application/x-www-form-urlencoded"
    });
    const parsed = JSON.parse(response);
    if (parsed.error) {
      const errCode = parsed.error;
      const errDesc = parsed.error_description || "";
      if (errCode === "invalid_grant") {
        throw new Error(`AUTH_EXPIRED: Refresh token expired or revoked (${errDesc})`);
      }
      throw new Error(`Token refresh failed: ${errDesc || errCode}`);
    }
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token || refreshToken,
      expiresAt: Date.now() + (parsed.expires_in || 3600) * 1e3,
      tokenType: parsed.token_type || "Bearer"
    };
  }
  /**
   * Fetches user profile (email, name, picture) using the access token.
   */
  async fetchUserInfo(accessToken) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "www.googleapis.com",
          port: 443,
          path: "/oauth2/v3/userinfo",
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": "AntigravitySwap/1.0"
          }
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => data += chunk);
          res.on("end", () => {
            try {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                const parsed = JSON.parse(data);
                resolve({
                  email: parsed.email,
                  name: parsed.name || parsed.email.split("@")[0],
                  avatarUrl: parsed.picture
                });
              } else if (res.statusCode === 403) {
                reject(new Error(`ACCOUNT_BANNED: Google returned 403 Forbidden: ${data}`));
              } else if (res.statusCode === 401) {
                reject(new Error(`AUTH_FAILED: Invalid credentials (401)`));
              } else {
                reject(new Error(`HTTP ${res.statusCode}: ${data}`));
              }
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  }
  httpsPost(hostname, path2, body, headers) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname,
          port: 443,
          path: path2,
          method: "POST",
          headers: {
            ...headers,
            "Content-Length": Buffer.byteLength(body),
            "User-Agent": "AntigravitySwap/1.0"
          }
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => data += chunk);
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
  base64URLEncode(buffer) {
    return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
};

// src/quotaService.ts
var https2 = __toESM(require("https"));
var QuotaService = class _QuotaService {
  constructor(oauthService) {
    this.oauthService = oauthService;
  }
  /**
   * Fetches the quota breakdown for an account using its access token.
   * If expired and a refresh token is available, automatically refreshes the token.
   */
  async fetchAccountQuotas(account, tokens, onTokenRefreshed) {
    let currentTokens = tokens;
    if (currentTokens.expiresAt && Date.now() > currentTokens.expiresAt - 12e4 && currentTokens.refreshToken) {
      try {
        currentTokens = await this.oauthService.refreshAccessToken(currentTokens.refreshToken);
        if (onTokenRefreshed) {
          await onTokenRefreshed(currentTokens);
        }
      } catch (err) {
        console.warn(`[QuotaService] Token auto-refresh failed for ${account.email}:`, err);
        if (err.message && (err.message.includes("AUTH_EXPIRED") || err.message.includes("invalid_grant"))) {
          return {
            quotas: [],
            averagePercentage: 0,
            hasWeeklyQuota: false,
            has5HourQuota: false,
            accountType: "Standard Free",
            tierBadge: "STANDARD FREE",
            status: "auth_failed",
            isBanned: false,
            statusMessage: "Refresh token expired or revoked. Please re-login."
          };
        }
      }
    }
    try {
      const quotaData = await this.fetchLiveQuotaData(currentTokens.accessToken);
      let parsedQuotas = this.parseQuotaResponse(quotaData);
      const { accountType, tierBadge } = this.determineAccountTier(quotaData, parsedQuotas);
      const isFree = tierBadge === "STANDARD FREE";
      if (parsedQuotas.length === 0) {
        console.log(`[QuotaService] No quota data returned for ${account.email}. Generating free-tier placeholder quotas.`);
        parsedQuotas = this.generateFreeTierPlaceholders();
      }
      const avgPercent = this.calculateAveragePercentage(parsedQuotas);
      const fiveHourQuotas = isFree ? [] : parsedQuotas.filter((q) => q.windowType === "5h");
      const weeklyQuotas = parsedQuotas.filter((q) => q.windowType === "weekly");
      const fiveHourPct = fiveHourQuotas.length > 0 ? this.calculateAveragePercentage(fiveHourQuotas) : void 0;
      const weeklyPct = weeklyQuotas.length > 0 ? this.calculateAveragePercentage(weeklyQuotas) : void 0;
      const isLow = avgPercent < 15 && avgPercent > 0;
      return {
        quotas: parsedQuotas,
        averagePercentage: avgPercent,
        fiveHourPercentage: fiveHourPct,
        weeklyPercentage: weeklyPct,
        has5HourQuota: fiveHourQuotas.length > 0,
        hasWeeklyQuota: weeklyQuotas.length > 0,
        accountType,
        tierBadge,
        status: isLow ? "low_balance" : "active",
        isBanned: false,
        statusMessage: isLow ? "Low quota warning" : void 0
      };
    } catch (err) {
      const errMsg = err.message || "";
      if (errMsg.includes("USER_SUSPENDED") || errMsg.includes("ACCOUNT_DISABLED") || errMsg.includes("TOS_VIOLATION") || errMsg.includes("Google Account disabled")) {
        return {
          quotas: [],
          averagePercentage: 0,
          hasWeeklyQuota: false,
          has5HourQuota: false,
          accountType: "Standard Free",
          tierBadge: "STANDARD FREE",
          status: "banned",
          isBanned: true,
          statusMessage: "Account disabled or suspended by Google Terms of Service"
        };
      }
      if ((errMsg.includes("401") || errMsg.includes("UNAUTHENTICATED")) && currentTokens.refreshToken) {
        try {
          currentTokens = await this.oauthService.refreshAccessToken(currentTokens.refreshToken);
          if (onTokenRefreshed) {
            await onTokenRefreshed(currentTokens);
          }
          const quotaData = await this.fetchLiveQuotaData(currentTokens.accessToken);
          const parsedQuotas = this.parseQuotaResponse(quotaData);
          const avgPercent = this.calculateAveragePercentage(parsedQuotas);
          const { accountType, tierBadge } = this.determineAccountTier(quotaData, parsedQuotas);
          const isFree = tierBadge === "STANDARD FREE";
          const fiveHourQuotas = isFree ? [] : parsedQuotas.filter((q) => q.windowType === "5h");
          const weeklyQuotas = parsedQuotas.filter((q) => q.windowType === "weekly");
          const fiveHourPct = fiveHourQuotas.length > 0 ? this.calculateAveragePercentage(fiveHourQuotas) : void 0;
          const weeklyPct = weeklyQuotas.length > 0 ? this.calculateAveragePercentage(weeklyQuotas) : void 0;
          const isLow = avgPercent < 15 && avgPercent > 0;
          return {
            quotas: parsedQuotas,
            averagePercentage: avgPercent,
            fiveHourPercentage: fiveHourPct,
            weeklyPercentage: weeklyPct,
            has5HourQuota: fiveHourQuotas.length > 0,
            hasWeeklyQuota: weeklyQuotas.length > 0,
            accountType,
            tierBadge,
            status: isLow ? "low_balance" : "active",
            isBanned: false,
            statusMessage: isLow ? "Low quota warning" : void 0
          };
        } catch (retryErr) {
          const isAuthExpired = retryErr.message?.includes("AUTH_EXPIRED") || retryErr.message?.includes("invalid_grant");
          return {
            quotas: [],
            averagePercentage: 0,
            hasWeeklyQuota: false,
            has5HourQuota: false,
            accountType: "Standard Free",
            tierBadge: "STANDARD FREE",
            status: isAuthExpired ? "auth_failed" : "active",
            isBanned: false,
            statusMessage: isAuthExpired ? "Credentials expired. Re-login required." : retryErr.message
          };
        }
      }
      return {
        quotas: [],
        averagePercentage: 0,
        fiveHourPercentage: void 0,
        weeklyPercentage: void 0,
        has5HourQuota: false,
        hasWeeklyQuota: false,
        accountType: "Standard Free",
        tierBadge: "STANDARD FREE",
        status: errMsg.includes("401") ? "auth_failed" : "active",
        isBanned: false,
        statusMessage: errMsg.includes("401") ? "Credentials expired. Re-login required." : void 0
      };
    }
  }
  /**
   * Multi-strategy live quota fetching against Cloud Code PA backend.
   */
  async fetchLiveQuotaData(accessToken) {
    let projectId;
    let tierData = {};
    const codeAssistEndpoints = [
      { host: "cloudcode-pa.googleapis.com", path: "/v1internal:loadCodeAssist", body: { metadata: { ideType: "ANTIGRAVITY" } } },
      { host: "daily-cloudcode-pa.googleapis.com", path: "/v1internal:loadCodeAssist", body: { metadata: { ide_type: "ANTIGRAVITY", ide_version: "1.22.2", ide_name: "antigravity" } } }
    ];
    for (const ep of codeAssistEndpoints) {
      try {
        const res = await this.callCloudCodePost(accessToken, ep.host, ep.path, ep.body);
        if (res) {
          if (res.cloudaicompanionProject) {
            projectId = res.cloudaicompanionProject;
          }
          tierData = { ...tierData, ...res };
          console.log(`[QuotaService] loadCodeAssist response keys: ${Object.keys(res).join(", ")}`);
          console.log(`[QuotaService] paidTier=${JSON.stringify(res.paidTier)}, currentTier=${JSON.stringify(res.currentTier)}, userTier=${JSON.stringify(res.userTier)}`);
          if (res.models || res.response?.groups || res.groups) {
            console.log("[QuotaService] Found model data in loadCodeAssist response!");
            return { ...tierData, ...res };
          }
          break;
        }
      } catch (err) {
        console.warn(`[QuotaService] loadCodeAssist failed: ${err.message}`);
      }
    }
    const modelCandidates = [
      { host: "daily-cloudcode-pa.sandbox.googleapis.com", path: "/v1internal:fetchAvailableModels" },
      { host: "daily-cloudcode-pa.googleapis.com", path: "/v1internal:fetchAvailableModels" },
      { host: "cloudcode-pa.googleapis.com", path: "/v1internal:fetchAvailableModels" },
      { host: "cloudcode-pa.googleapis.com", path: "/v1internal:retrieveUserQuotaSummary" }
    ];
    for (const cand of modelCandidates) {
      try {
        const body = projectId ? { project: projectId } : {};
        const res = await this.callCloudCodePost(accessToken, cand.host, cand.path, body);
        console.log(`[QuotaService] ${cand.host}${cand.path} \u2192 keys: ${Object.keys(res || {}).join(", ")}`);
        if (res && (res.models || res.response?.groups || res.groups)) {
          return { ...tierData, ...res };
        }
      } catch (err) {
        console.warn(`[QuotaService] ${cand.host}${cand.path} failed: ${err.message}`);
      }
    }
    console.warn("[QuotaService] No model quota data found from any endpoint. Returning tier-only data.");
    return tierData;
  }
  callCloudCodePost(accessToken, hostname, path2, body = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = https2.request(
        {
          hostname,
          port: 443,
          path: path2,
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": "antigravity/1.22.2 windows",
            "Content-Length": Buffer.byteLength(data)
          },
          timeout: 8e3
        },
        (res) => {
          let resData = "";
          res.on("data", (chunk) => resData += chunk);
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(resData));
              } catch (e) {
                reject(new Error(`Failed to parse response: ${resData}`));
              }
            } else if (res.statusCode === 403) {
              reject(new Error(`403 PERMISSION_DENIED: ${resData}`));
            } else if (res.statusCode === 401) {
              reject(new Error(`401 UNAUTHENTICATED: ${resData}`));
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${resData}`));
            }
          });
        }
      );
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }
  /**
   * Parses model quotas from the API response:
   * - Extracts real percentages from models / groups
   * - Filters out tab fast autocomplete
   * - Filters out thinking effort / budget entries
   * - Keeps fixed, deterministic Antigravity IDE order
   */
  parseQuotaResponse(rawResponse) {
    const list = [];
    const seenIds = /* @__PURE__ */ new Set();
    const shouldIgnoreModel = (id, name) => {
      const s = (id + " " + name).toLowerCase();
      return s.includes("tab_") || s.includes("tab-") || s.includes("autocomplete") || s.includes("tab completion") || s.includes("thinking effort") || s.includes("thinking_effort") || s.includes("thinking-effort") || s.includes("thinking budget") || s.includes("thinking_budget") || s.includes("thinking-budget") || s.includes("thinking_slider") || s.includes("thinking-slider") || s.includes("thinking_") || s.startsWith("chat_") || s.startsWith("chat-") || /^chat_\d+/.test(s) || /^chat \d+/.test(s);
    };
    if (rawResponse && rawResponse.models) {
      for (const [modelId, modelData] of Object.entries(rawResponse.models)) {
        const displayName = this.formatModelDisplayName(modelId, modelData.displayName);
        if (shouldIgnoreModel(modelId, displayName)) {
          continue;
        }
        const normId = this.normalizeModelKey(modelId);
        if (seenIds.has(normId)) continue;
        seenIds.add(normId);
        const quotaInfo = modelData.quotaInfo || {};
        let fraction = 0;
        if (typeof quotaInfo.remainingFraction === "number") {
          fraction = quotaInfo.remainingFraction;
        } else if (typeof quotaInfo.fraction === "number") {
          fraction = quotaInfo.fraction;
        } else if (typeof quotaInfo.remainingQuota === "number") {
          fraction = quotaInfo.remainingQuota;
        }
        fraction = Math.max(0, Math.min(1, fraction));
        const percentage = Math.round(fraction * 100);
        const resetTime = quotaInfo.resetTime;
        const resetCountdown = resetTime ? this.formatCountdown(resetTime) : void 0;
        const { windowType, windowLabel } = this.classifyQuotaWindow(modelId, displayName, resetTime, modelData.description);
        list.push({
          id: modelId,
          displayName,
          description: modelData.description,
          remainingFraction: fraction,
          percentage,
          resetTime,
          resetCountdown,
          windowType,
          windowLabel,
          disabled: modelData.disabled ?? false
        });
      }
    }
    const groups = rawResponse?.response?.groups || rawResponse?.groups || [];
    for (const group of groups) {
      const buckets = group.buckets || [];
      for (const bucket of buckets) {
        if (!bucket.displayName && !bucket.bucketId) continue;
        const rawId = bucket.bucketId || bucket.displayName;
        const displayName = this.formatModelDisplayName(rawId, bucket.displayName);
        if (shouldIgnoreModel(rawId, displayName)) {
          continue;
        }
        const normId = this.normalizeModelKey(rawId);
        if (seenIds.has(normId)) continue;
        seenIds.add(normId);
        let fraction = 0;
        if (bucket.remaining?.case === "remainingFraction") {
          fraction = typeof bucket.remaining.value === "number" ? bucket.remaining.value : 0;
        } else if (typeof bucket.remainingFraction === "number") {
          fraction = bucket.remainingFraction;
        } else if (typeof bucket.fraction === "number") {
          fraction = bucket.fraction;
        }
        fraction = Math.max(0, Math.min(1, fraction));
        const percentage = Math.round(fraction * 100);
        const resetTime = bucket.quotaInfo?.resetTime || bucket.resetTime || bucket.quotaResetUTCTimestamp;
        const resetCountdown = resetTime ? this.formatCountdown(resetTime) : void 0;
        const { windowType, windowLabel } = this.classifyQuotaWindow(rawId, displayName, resetTime, bucket.description || group.displayName);
        list.push({
          id: rawId,
          displayName,
          description: bucket.description || group.displayName,
          remainingFraction: fraction,
          percentage,
          resetTime,
          resetCountdown,
          windowType,
          windowLabel,
          disabled: bucket.disabled ?? false,
          refreshText: bucket.refreshText || bucket.description
        });
      }
    }
    return _QuotaService.sortModelQuotas(list);
  }
  /**
   * Generates placeholder quota entries for standard free accounts when the API
   * returns no quota breakdown (free tier endpoints return no model quota data).
   * Shows all models accessible in Antigravity IDE with a "Free Tier" indicator.
   */
  generateFreeTierPlaceholders() {
    const freeTierModels = [
      { id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", windowType: "5h" },
      { id: "gemini-3.7-flash", displayName: "Gemini 3.7 Flash", windowType: "5h" },
      { id: "gemini-3.6-flash", displayName: "Gemini 3.6 Flash", windowType: "5h" },
      { id: "gemini-3.1-flash", displayName: "Gemini 3.1 Flash", windowType: "5h" },
      { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", windowType: "weekly" },
      { id: "claude-opus-4-6", displayName: "Claude Opus 4.6", windowType: "weekly" },
      { id: "gpt-oss-120b", displayName: "GPT-OSS 120B", windowType: "weekly" }
    ];
    const description = "Free Tier \u2014 quota not available via API";
    return freeTierModels.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      description,
      remainingFraction: -1,
      // Sentinel: means "not measurable via API"
      percentage: -1,
      // Displayed as "Free Tier" in UI
      windowType: m.windowType,
      windowLabel: "Free Tier Usage",
      disabled: false,
      refreshText: description
    }));
  }
  /**
   * Normalizes model ID key to prevent duplicate tiers (e.g. high/low variations)
   */
  normalizeModelKey(id) {
    return id.toLowerCase().replace(/-high|-medium|-low|-tiered|-extra-low/g, "");
  }
  /**
   * Formats model display names to match the Antigravity IDE model picker exactly:
   * Gemini 3.8 / 3.7 / 3.6 / 3.1 Flash, Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B.
   */
  formatModelDisplayName(id, apiDisplayName) {
    const lower = id.toLowerCase();
    if (lower.includes("claude-sonnet-4-6") || lower.includes("sonnet-4-6") || lower.includes("claude-3-7-sonnet") || lower.includes("claude-3.7-sonnet")) {
      return "Claude Sonnet 4.6";
    }
    if (lower.includes("claude-3-5-sonnet") || lower.includes("claude-3.5-sonnet")) {
      return "Claude Sonnet 3.5";
    }
    if (lower.includes("claude-sonnet")) return "Claude Sonnet 4.6";
    if (lower.includes("claude-opus-4-6") || lower.includes("opus-4-6") || lower.includes("claude-3-opus") || lower.includes("claude-3.7-opus")) {
      return "Claude Opus 4.6";
    }
    if (lower.includes("claude-opus")) return "Claude Opus 4.6";
    if (lower.includes("gpt-oss") || lower.includes("gpt_oss")) {
      return "GPT-OSS 120B";
    }
    const verMatch = id.match(/gemini-(\d+(?:\.\d+)?)-([a-z]+)/i);
    if (verMatch) {
      const version = verMatch[1];
      const type = verMatch[2].charAt(0).toUpperCase() + verMatch[2].slice(1).toLowerCase();
      return `Gemini ${version} ${type}`;
    }
    if (apiDisplayName && !apiDisplayName.toLowerCase().includes("thinking")) {
      return apiDisplayName;
    }
    return id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/Gpt Oss/i, "GPT-OSS");
  }
  /**
   * Enforces a fixed, deterministic order matching Antigravity IDE standard model picker:
   * 1. Gemini 3.8 Flash
   * 2. Gemini 3.7 Flash
   * 3. Gemini 3.6 Flash
   * 4. Gemini 3.5 Flash
   * IDE model picker order:
   * 1. Gemini 3.8 Flash
   * 2. Gemini 3.7 Flash
   * 3. Gemini 3.6 Flash
   * 4. Gemini 3.1 Flash
   * 5. Claude Sonnet 4.6
   * 6. Claude Opus 4.6
   * 7. GPT-OSS 120B
   */
  static sortModelQuotas(quotas) {
    const getRank = (q) => {
      const s = (q.id + " " + (q.displayName || "")).toLowerCase();
      if (s.includes("3.8-flash") || s.includes("3.8 flash")) return 10;
      if (s.includes("3.7-flash") || s.includes("3.7 flash")) return 20;
      if (s.includes("3.6-flash") || s.includes("3.6 flash")) return 30;
      if (s.includes("3.1-flash") || s.includes("3.1 flash")) return 40;
      if (s.includes("3.5-flash") || s.includes("3.5 flash")) return 45;
      if (s.includes("gemini-3-flash") || s.includes("gemini 3 flash") || s.includes("gemini-3.0-flash")) return 50;
      if (s.includes("gemini") && s.includes("flash")) return 60;
      if (s.includes("gemini") && s.includes("pro")) return 70;
      if (s.includes("gemini")) return 80;
      if (s.includes("claude") && (s.includes("sonnet-4-6") || s.includes("sonnet 4.6") || s.includes("sonnet"))) return 100;
      if (s.includes("claude") && (s.includes("opus-4-6") || s.includes("opus 4.6") || s.includes("opus"))) return 110;
      if (s.includes("claude")) return 130;
      if (s.includes("gpt-oss") || s.includes("gpt_oss") || s.includes("gpt oss")) return 200;
      return 500;
    };
    return [...quotas].sort((a, b) => getRank(a) - getRank(b));
  }
  /**
   * Classifies a model quota into 5h rolling window vs weekly plan quota.
   */
  classifyQuotaWindow(id, displayName, resetTime, description) {
    const idLower = (id + " " + displayName + " " + (description || "")).toLowerCase();
    if (resetTime) {
      try {
        const diffMs = new Date(resetTime).getTime() - Date.now();
        const diffHours = diffMs / (1e3 * 60 * 60);
        if (diffHours > 24) {
          return { windowType: "weekly", windowLabel: "Weekly Plan Quota" };
        } else if (diffHours > 0 && diffHours <= 6) {
          return { windowType: "5h", windowLabel: "5-Hour Rolling Window" };
        }
      } catch {
      }
    }
    if (idLower.includes("claude") || idLower.includes("opus") || idLower.includes("sonnet") || idLower.includes("gpt-oss") || idLower.includes("gemini-2.5-pro") || idLower.includes("weekly") || idLower.includes("pro-agent")) {
      return { windowType: "weekly", windowLabel: "Weekly Plan Quota" };
    }
    return { windowType: "5h", windowLabel: "5-Hour Rolling Window" };
  }
  /**
   * Determines account subscription tier strictly based on Google account subscription data.
   * Standard free accounts will always receive 'STANDARD FREE' without Pro badge.
   */
  determineAccountTier(rawResponse, _quotas) {
    const paidTierName = (rawResponse?.paidTier?.name || "").toLowerCase();
    const currentTierName = (rawResponse?.currentTier?.name || "").toLowerCase();
    const userTierDesc = (rawResponse?.userTier?.description || rawResponse?.userTier?.tierDisplayName || "").toLowerCase();
    const allTierStr = `${paidTierName} ${currentTierName} ${userTierDesc}`;
    if (allTierStr.includes("enterprise")) {
      return { accountType: "Antigravity Enterprise", tierBadge: "ENTERPRISE" };
    }
    if (allTierStr.includes("ultra")) {
      return { accountType: "Google One Ultra", tierBadge: "AI PREMIUM" };
    }
    if (allTierStr.includes("ai premium") || allTierStr.includes("ai_premium") || allTierStr.includes("gemini advanced") || allTierStr.includes("premium")) {
      return { accountType: "Google One AI Premium", tierBadge: "AI PREMIUM" };
    }
    if (/\b(pro|google_one_pro|tier_pro)\b/.test(allTierStr)) {
      return { accountType: "Google One Pro", tierBadge: "PRO" };
    }
    return { accountType: "Standard Free", tierBadge: "STANDARD FREE" };
  }
  /**
   * Computes overall aggregate percentage across all healthy accounts.
   */
  calculateOverallSummary(accounts) {
    if (accounts.length === 0) {
      return {
        totalAccounts: 0,
        overallPercentage: 0,
        overall5HourPercentage: 0,
        overallWeeklyPercentage: 0,
        averageActiveAccountPercentage: 0,
        highestAccountQuotaPercentage: 0,
        accountsWithHealthyQuota: 0,
        accountsLowOrDepleted: 0,
        accountsWithErrors: 0,
        proAccountsCount: 0,
        lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    const activeAcc = accounts.find((a) => a.isActive) || accounts[0];
    let sumPercentages = 0;
    let sum5hPercentages = 0;
    let count5h = 0;
    let sumWeeklyPercentages = 0;
    let countWeekly = 0;
    let maxPercentage = 0;
    let healthyCount = 0;
    let lowCount = 0;
    let errorCount = 0;
    let proCount = 0;
    for (const acc of accounts) {
      if (acc.tierBadge === "PRO" || acc.tierBadge === "AI PREMIUM" || acc.tierBadge === "ENTERPRISE") {
        proCount++;
      }
      if (acc.isBanned || acc.status === "auth_failed" || acc.status === "banned") {
        errorCount++;
        continue;
      }
      healthyCount++;
      const p = acc.averageQuotaPercentage || 0;
      sumPercentages += p;
      if (p > maxPercentage) maxPercentage = p;
      if (p < 20) {
        lowCount++;
      }
      if (acc.fiveHourQuotaPercentage !== void 0) {
        sum5hPercentages += acc.fiveHourQuotaPercentage;
        count5h++;
      }
      if (acc.weeklyQuotaPercentage !== void 0) {
        sumWeeklyPercentages += acc.weeklyQuotaPercentage;
        countWeekly++;
      }
    }
    const validCount = Math.max(1, accounts.length - errorCount);
    const overallPct = Math.round(sumPercentages / validCount);
    const overall5hPct = count5h > 0 ? Math.round(sum5hPercentages / count5h) : void 0;
    const overallWeeklyPct = countWeekly > 0 ? Math.round(sumWeeklyPercentages / countWeekly) : void 0;
    const activePct = activeAcc ? activeAcc.averageQuotaPercentage || 0 : 0;
    return {
      totalAccounts: accounts.length,
      activeAccountEmail: activeAcc?.email,
      overallPercentage: errorCount === accounts.length ? 0 : overallPct,
      overall5HourPercentage: overall5hPct,
      overallWeeklyPercentage: overallWeeklyPct,
      averageActiveAccountPercentage: activePct,
      highestAccountQuotaPercentage: maxPercentage,
      accountsWithHealthyQuota: healthyCount,
      accountsLowOrDepleted: lowCount,
      accountsWithErrors: errorCount,
      proAccountsCount: proCount,
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  calculateAveragePercentage(quotas) {
    if (!quotas || quotas.length === 0) return 0;
    const valid = quotas.filter((q) => !q.disabled && q.percentage >= 0);
    if (valid.length === 0) return 0;
    const sum = valid.reduce((acc, q) => acc + q.percentage, 0);
    return Math.round(sum / valid.length);
  }
  formatCountdown(isoString) {
    try {
      const target = new Date(isoString).getTime();
      const diff = target - Date.now();
      if (diff <= 0) return "Ready";
      const hours = Math.floor(diff / (1e3 * 60 * 60));
      const mins = Math.floor(diff % (1e3 * 60 * 60) / (1e3 * 60));
      if (hours > 24) {
        const days = Math.floor(hours / 24);
        const remHours = hours % 24;
        return `${days}d ${remHours}h`;
      }
      if (hours > 0) {
        return `${hours}h ${mins}m`;
      }
      return `${mins}m`;
    } catch {
      return "Soon";
    }
  }
};

// src/accountManager.ts
var vscode3 = __toESM(require("vscode"));
var AccountManager = class {
  constructor(storage, oauthService, quotaService) {
    this.storage = storage;
    this.oauthService = oauthService;
    this.quotaService = quotaService;
  }
  accounts = [];
  activeEmail;
  _onDidChangeState = new vscode3.EventEmitter();
  onDidChangeState = this._onDidChangeState.event;
  async initialize() {
    this.accounts = this.storage.getAccounts();
    this.activeEmail = this.storage.getActiveAccountEmail();
    if (this.accounts.length === 0) {
      await this.importDetectedAccounts();
    }
    await this.refreshAllQuotas().catch((err) => console.warn("[Antigravity Swap] Initial quota refresh failed:", err));
    const active = this.getActiveAccount();
    if (!active || active.status === "auth_failed" || active.isBanned) {
      const liveAccounts = this.accounts.filter((a) => a.status === "active" && !a.isBanned);
      if (liveAccounts.length > 0) {
        const liveCandidate = liveAccounts.find((a) => (a.averageQuotaPercentage ?? 0) > 0) || liveAccounts[0];
        console.log(`[Antigravity Swap] Auto-switching from unavailable account (${active?.email || "none"}) to live account: ${liveCandidate.email}`);
        await this.switchAccount(liveCandidate.email);
        vscode3.window.showInformationMessage(`Auto-switched to active live account: ${liveCandidate.name || liveCandidate.email}`);
      } else {
        console.log("[Antigravity Swap] No live accounts available to auto-switch.");
      }
    }
  }
  getAccounts() {
    return this.accounts;
  }
  getActiveAccount() {
    if (!this.activeEmail) return void 0;
    const match = this.accounts.find((a) => a.email === this.activeEmail && a.isActive);
    return match;
  }
  getOverallSummary() {
    return this.quotaService.calculateOverallSummary(this.accounts);
  }
  /**
   * Switches to the given account and relaunches Antigravity IDE with the new account loaded into memory.
   */
  isAutoSwitchEnabled() {
    return this.storage.getAutoSwitchEnabled();
  }
  async setAutoSwitchEnabled(enabled) {
    await this.storage.setAutoSwitchEnabled(enabled);
    this._onDidChangeState.fire();
  }
  /**
   * Switches to the given account and relaunches Antigravity IDE with the new account loaded into memory.
   * @param email Target account email.
   * @param isManual Set to true when the user explicitly pressed "Switch" — this disables auto-switch.
   */
  async switchAccount(email, isManual = false) {
    const target = this.accounts.find((a) => a.email === email);
    if (!target) {
      vscode3.window.showErrorMessage(`Account ${email} not found in Antigravity Swap.`);
      return false;
    }
    if (target.isBanned || target.status === "banned") {
      vscode3.window.showErrorMessage(`Cannot switch: Account ${email} is banned or suspended by Google Terms of Service.`);
      return false;
    }
    if (target.status === "auth_failed") {
      const choice = await vscode3.window.showErrorMessage(
        `Cannot switch: Account ${email} authentication failed / credentials expired. Re-login now?`,
        "Re-login Account",
        "Cancel"
      );
      if (choice === "Re-login Account") {
        await this.reloginAccount(email);
      }
      return false;
    }
    let tokens = await this.storage.getAccountTokens(email);
    if (!tokens || !tokens.accessToken) {
      target.status = "auth_failed";
      target.statusMessage = "Credentials missing. Re-login required.";
      target.quotas = [];
      target.averageQuotaPercentage = 0;
      await this.storage.saveAccounts(this.accounts);
      this._onDidChangeState.fire();
      const reloginChoice = await vscode3.window.showWarningMessage(
        `Cannot switch: Credentials missing or expired for ${email}. Re-login now?`,
        "Re-login Account",
        "Cancel"
      );
      if (reloginChoice === "Re-login Account") {
        await this.reloginAccount(email);
      }
      return false;
    }
    if (tokens.expiresAt && Date.now() > tokens.expiresAt - 6e4 && tokens.refreshToken) {
      try {
        tokens = await this.oauthService.refreshAccessToken(tokens.refreshToken);
        await this.storage.saveAccountTokens(email, tokens);
      } catch (err) {
        console.warn(`[Antigravity Swap] Token refresh failed before switch: ${err.message}`);
        target.status = "auth_failed";
        target.statusMessage = "Credentials expired. Re-login required.";
        target.quotas = [];
        target.averageQuotaPercentage = 0;
        await this.storage.saveAccounts(this.accounts);
        this._onDidChangeState.fire();
        const rechoice = await vscode3.window.showErrorMessage(
          `Cannot switch: Credentials for ${email} expired. Please re-login.`,
          "Re-login Now",
          "Cancel"
        );
        if (rechoice === "Re-login Now") {
          await this.reloginAccount(email);
        }
        return false;
      }
    }
    this.accounts = this.accounts.map((a) => ({
      ...a,
      isActive: a.email === email,
      lastUsedAt: a.email === email ? (/* @__PURE__ */ new Date()).toISOString() : a.lastUsedAt
    }));
    this.activeEmail = email;
    await this.storage.saveAccounts(this.accounts);
    await this.storage.setActiveAccountEmail(email);
    if (isManual) {
      await this.storage.setAutoSwitchEnabled(false);
    }
    await this.storage.liveSwitchOAuthToken(target, tokens);
    await this.storage.syncToIdeStateDb(target, tokens);
    await this.storage.syncToCloudAccountsDb(email);
    this._onDidChangeState.fire();
    this.refreshAccountQuota(email).catch(() => {
    });
    vscode3.window.showInformationMessage(`Switched to: ${target.name || email}! (Live switch complete)`);
    return true;
  }
  /**
   * Re-authenticates / reconnects a specific account by launching Google browser login.
   */
  async reloginAccount(email) {
    try {
      const result = await vscode3.window.withProgress(
        {
          location: vscode3.ProgressLocation.Notification,
          title: `Antigravity Swap: Opening browser to authenticate ${email}...`,
          cancellable: true
        },
        async () => {
          return await this.oauthService.loginWithGoogle(email);
        }
      );
      const { tokens, userInfo } = result;
      await this.storage.saveAccountTokens(userInfo.email, tokens);
      const existingIdx = this.accounts.findIndex((a) => a.email === userInfo.email || a.email === email);
      if (existingIdx >= 0) {
        this.accounts[existingIdx] = {
          ...this.accounts[existingIdx],
          email: userInfo.email,
          name: userInfo.name || this.accounts[existingIdx].name,
          avatarUrl: userInfo.avatarUrl || this.accounts[existingIdx].avatarUrl,
          status: "active",
          isBanned: false,
          banReason: void 0,
          statusMessage: void 0,
          lastUsedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
      } else {
        this.accounts.push({
          id: Buffer.from(userInfo.email).toString("base64").substring(0, 16),
          email: userInfo.email,
          name: userInfo.name,
          avatarUrl: userInfo.avatarUrl,
          isActive: false,
          addedAt: (/* @__PURE__ */ new Date()).toISOString(),
          status: "active",
          isBanned: false,
          quotas: [],
          averageQuotaPercentage: 0,
          hasWeeklyQuota: false,
          has5HourQuota: false,
          accountType: "Standard Free",
          tierBadge: "STANDARD FREE"
        });
      }
      await this.storage.saveAccounts(this.accounts);
      vscode3.window.showInformationMessage(`Re-authenticated ${userInfo.email} successfully!`);
      this._onDidChangeState.fire();
      await this.refreshAccountQuota(userInfo.email).catch(() => {
      });
      if (this.activeEmail === userInfo.email || this.activeEmail === email) {
        await this.switchAccount(userInfo.email);
      }
      return true;
    } catch (err) {
      vscode3.window.showErrorMessage(`Re-login error: ${err.message}`);
      return false;
    }
  }
  /**
   * Imports or updates the account currently logged into Antigravity IDE.
   */
  async importCurrentAntigravityAccount() {
    const current = await this.storage.getCurrentAntigravityAccount();
    if (!current || !current.email || !current.accessToken) {
      vscode3.window.showWarningMessage("No active Antigravity session with valid access token found in state database.");
      return null;
    }
    const tokens = {
      accessToken: current.accessToken,
      refreshToken: current.refreshToken,
      expiresAt: Date.now() + 3600 * 1e3
    };
    await this.storage.saveAccountTokens(current.email, tokens);
    const existingIdx = this.accounts.findIndex((a) => a.email === current.email);
    let account;
    if (existingIdx >= 0) {
      account = {
        ...this.accounts[existingIdx],
        name: current.name || this.accounts[existingIdx].name,
        avatarUrl: current.avatarUrl || this.accounts[existingIdx].avatarUrl,
        status: "active",
        isBanned: false,
        statusMessage: void 0,
        isActive: true,
        lastUsedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.accounts[existingIdx] = account;
    } else {
      account = {
        id: Buffer.from(current.email).toString("base64").substring(0, 16),
        email: current.email,
        name: current.name,
        avatarUrl: current.avatarUrl,
        isActive: true,
        addedAt: (/* @__PURE__ */ new Date()).toISOString(),
        status: "active",
        isBanned: false,
        statusMessage: void 0,
        quotas: [],
        averageQuotaPercentage: 0,
        hasWeeklyQuota: false,
        has5HourQuota: false,
        accountType: "Standard Free",
        tierBadge: "STANDARD FREE"
      };
      this.accounts.push(account);
    }
    this.accounts = this.accounts.map((a) => ({
      ...a,
      isActive: a.email === current.email
    }));
    this.activeEmail = current.email;
    await this.storage.saveAccounts(this.accounts);
    await this.storage.setActiveAccountEmail(this.activeEmail);
    vscode3.window.showInformationMessage(`Successfully imported active account ${current.email} from Antigravity IDE!`);
    this._onDidChangeState.fire();
    this.refreshAccountQuota(current.email).catch(() => {
    });
    return account;
  }
  /**
   * Adds an account via Google OAuth web authorization.
   */
  async addAccountViaOAuth() {
    try {
      const result = await vscode3.window.withProgress(
        {
          location: vscode3.ProgressLocation.Notification,
          title: "Antigravity Swap: Opening browser to authenticate with Google...",
          cancellable: true
        },
        async () => {
          return await this.oauthService.loginWithGoogle();
        }
      );
      const { tokens, userInfo } = result;
      await this.storage.saveAccountTokens(userInfo.email, tokens);
      const existingIdx = this.accounts.findIndex((a) => a.email === userInfo.email);
      let account;
      if (existingIdx >= 0) {
        account = {
          ...this.accounts[existingIdx],
          name: userInfo.name || this.accounts[existingIdx].name,
          avatarUrl: userInfo.avatarUrl || this.accounts[existingIdx].avatarUrl,
          status: "active",
          isBanned: false,
          lastUsedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        this.accounts[existingIdx] = account;
      } else {
        account = {
          id: Buffer.from(userInfo.email).toString("base64").substring(0, 16),
          email: userInfo.email,
          name: userInfo.name,
          avatarUrl: userInfo.avatarUrl,
          isActive: this.accounts.length === 0,
          addedAt: (/* @__PURE__ */ new Date()).toISOString(),
          status: "active",
          isBanned: false,
          quotas: [],
          averageQuotaPercentage: 0,
          hasWeeklyQuota: false,
          has5HourQuota: false,
          accountType: "Standard Free",
          tierBadge: "STANDARD FREE"
        };
        this.accounts.push(account);
      }
      await this.storage.saveAccounts(this.accounts);
      if (account.isActive) {
        await this.switchAccount(account.email);
      }
      vscode3.window.showInformationMessage(`Added account ${userInfo.email} to Antigravity Swap!`);
      this._onDidChangeState.fire();
      this.refreshAccountQuota(account.email).catch(() => {
      });
      return account;
    } catch (err) {
      vscode3.window.showErrorMessage(`Login failed: ${err.message}`);
      return null;
    }
  }
  /**
   * Adds an account manually via Access Token or Refresh Token input.
   */
  async addAccountManually(email, accessToken, refreshToken, name) {
    if (!email || !accessToken) {
      vscode3.window.showErrorMessage("Email and Access Token are required.");
      return false;
    }
    const tokens = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + 3600 * 1e3
    };
    await this.storage.saveAccountTokens(email, tokens);
    const existingIdx = this.accounts.findIndex((a) => a.email === email);
    if (existingIdx >= 0) {
      this.accounts[existingIdx].name = name || this.accounts[existingIdx].name;
      this.accounts[existingIdx].status = "active";
      this.accounts[existingIdx].isBanned = false;
      this.accounts[existingIdx].statusMessage = void 0;
    } else {
      this.accounts.push({
        id: Buffer.from(email).toString("base64").substring(0, 16),
        email,
        name: name || email.split("@")[0],
        isActive: this.accounts.length === 0,
        addedAt: (/* @__PURE__ */ new Date()).toISOString(),
        status: "active",
        isBanned: false,
        quotas: [],
        averageQuotaPercentage: 0,
        hasWeeklyQuota: false,
        has5HourQuota: false,
        accountType: "Standard Free",
        tierBadge: "STANDARD FREE"
      });
    }
    await this.storage.saveAccounts(this.accounts);
    vscode3.window.showInformationMessage(`Account ${email} saved successfully!`);
    this._onDidChangeState.fire();
    this.refreshAccountQuota(email).catch(() => {
    });
    return true;
  }
  /**
   * Removes an account.
   */
  async removeAccount(email) {
    const isCurrentActive = this.activeEmail === email;
    this.accounts = this.accounts.filter((a) => a.email !== email);
    await this.storage.saveAccounts(this.accounts);
    await this.storage.removeAccountTokens(email);
    if (isCurrentActive && this.accounts.length > 0) {
      const nextHealthy = this.accounts.find((a) => !a.isBanned && a.status === "active") || this.accounts[0];
      if (nextHealthy && nextHealthy.status === "active") {
        await this.switchAccount(nextHealthy.email);
      } else {
        this.activeEmail = void 0;
        await this.storage.setActiveAccountEmail(void 0);
      }
    } else if (this.accounts.length === 0) {
      this.activeEmail = void 0;
      await this.storage.setActiveAccountEmail(void 0);
    }
    vscode3.window.showInformationMessage(`Account ${email} removed.`);
    this._onDidChangeState.fire();
  }
  /**
   * Refreshes quota balances for all accounts with credentials.
   */
  async refreshAllQuotas() {
    for (const acc of this.accounts) {
      await this.refreshAccountQuota(acc.email);
    }
    await this.checkAutoSwitch();
    this._onDidChangeState.fire();
  }
  async refreshAccountQuota(email) {
    const acc = this.accounts.find((a) => a.email === email);
    if (!acc) return;
    const tokens = await this.storage.getAccountTokens(email);
    if (!tokens || !tokens.accessToken) {
      acc.status = "auth_failed";
      acc.statusMessage = "Credentials missing. Re-login required.";
      acc.quotas = [];
      acc.averageQuotaPercentage = 0;
      acc.fiveHourQuotaPercentage = void 0;
      acc.weeklyQuotaPercentage = void 0;
      await this.storage.saveAccounts(this.accounts);
      this._onDidChangeState.fire();
      return;
    }
    const res = await this.quotaService.fetchAccountQuotas(acc, tokens, async (newTokens) => {
      await this.storage.saveAccountTokens(email, newTokens);
    });
    acc.quotas = res.quotas;
    acc.averageQuotaPercentage = res.averagePercentage;
    acc.fiveHourQuotaPercentage = res.fiveHourPercentage;
    acc.weeklyQuotaPercentage = res.weeklyPercentage;
    acc.has5HourQuota = res.has5HourQuota;
    acc.hasWeeklyQuota = res.hasWeeklyQuota;
    acc.accountType = res.accountType;
    acc.tierBadge = res.tierBadge;
    acc.status = res.status;
    acc.isBanned = res.isBanned;
    acc.banReason = res.isBanned ? res.statusMessage : void 0;
    acc.statusMessage = res.statusMessage;
    acc.lastRefreshedAt = (/* @__PURE__ */ new Date()).toISOString();
    acc.lastHeartbeatAt = (/* @__PURE__ */ new Date()).toISOString();
    await this.storage.saveAccounts(this.accounts);
    this._onDidChangeState.fire();
  }
  /**
   * Heartbeat execution: polls active account quota and checks background account status.
   */
  async runHeartbeatTick() {
    const active = this.getActiveAccount();
    if (active) {
      await this.refreshAccountQuota(active.email);
    }
    const bgAccounts = this.accounts.filter((a) => a.email !== active?.email && a.status === "active");
    if (bgAccounts.length > 0) {
      const oldestSynced = bgAccounts.sort((a, b) => {
        const tA = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : 0;
        const tB = b.lastHeartbeatAt ? new Date(b.lastHeartbeatAt).getTime() : 0;
        return tA - tB;
      })[0];
      if (oldestSynced) {
        await this.refreshAccountQuota(oldestSynced.email);
      }
    }
    await this.checkAutoSwitch();
  }
  /**
   * Auto-switches to next account with healthy quota if current account is exhausted or banned.
   */
  async checkAutoSwitch() {
    const autoSwitch = this.storage.getAutoSwitchEnabled();
    if (!autoSwitch) return;
    const active = this.getActiveAccount();
    if (!active) return;
    const config = vscode3.workspace.getConfiguration("antigravitySwap");
    const threshold = config.get("lowQuotaThresholdPercent", 10);
    const isDepleted = active.averageQuotaPercentage <= threshold;
    const isUnusable = active.isBanned || active.status === "auth_failed" || active.status === "banned";
    if (isDepleted || isUnusable) {
      const candidate = this.accounts.find(
        (a) => a.email !== active.email && !a.isBanned && a.status === "active" && a.averageQuotaPercentage > threshold
      );
      if (candidate) {
        const reason = isUnusable ? "account credentials/ban status" : `low quota (${active.averageQuotaPercentage}%)`;
        vscode3.window.showWarningMessage(
          `Account ${active.email} has ${reason}. Auto-switching to ${candidate.email} (${candidate.averageQuotaPercentage}% left)...`
        );
        await this.switchAccount(candidate.email);
      }
    }
  }
  /**
   * Auto-discovers existing accounts on local machine and adds them.
   */
  async importDetectedAccounts() {
    const discovered = await this.storage.discoverExistingAccounts();
    let addedCount = 0;
    const currentSession = await this.storage.getCurrentAntigravityAccount();
    for (const disc of discovered) {
      const exists = this.accounts.find((a) => a.email === disc.email);
      const isCurrentSession = currentSession?.email === disc.email;
      const hasToken = !!disc.accessToken;
      if (!exists) {
        this.accounts.push({
          id: Buffer.from(disc.email).toString("base64").substring(0, 16),
          email: disc.email,
          name: disc.name,
          avatarUrl: disc.avatarUrl,
          isActive: isCurrentSession,
          addedAt: (/* @__PURE__ */ new Date()).toISOString(),
          status: hasToken ? "active" : "auth_failed",
          statusMessage: hasToken ? "Discovered" : "Click Re-login to authenticate",
          isBanned: false,
          quotas: [],
          averageQuotaPercentage: 0,
          hasWeeklyQuota: false,
          has5HourQuota: false,
          accountType: "Standard Free",
          tierBadge: "STANDARD FREE"
        });
        addedCount++;
        if (disc.accessToken) {
          await this.storage.saveAccountTokens(disc.email, {
            accessToken: disc.accessToken,
            refreshToken: disc.refreshToken
          });
        }
      }
    }
    if (addedCount > 0) {
      if (currentSession?.email) {
        this.activeEmail = currentSession.email;
        await this.storage.setActiveAccountEmail(this.activeEmail);
      }
      await this.storage.saveAccounts(this.accounts);
      this._onDidChangeState.fire();
    }
    return addedCount;
  }
};

// src/statusBar.ts
var vscode4 = __toESM(require("vscode"));
var StatusBarService = class {
  constructor(accountManager) {
    this.accountManager = accountManager;
    this.statusBarItem = vscode4.window.createStatusBarItem(
      vscode4.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = "antigravitySwap.openQuickMenu";
    this.disposables.push(this.statusBarItem);
    this.disposables.push(
      this.accountManager.onDidChangeState(() => this.update())
    );
    this.update();
    this.statusBarItem.show();
  }
  statusBarItem;
  disposables = [];
  update() {
    const accounts = this.accountManager.getAccounts();
    const active = this.accountManager.getActiveAccount();
    const overall = this.accountManager.getOverallSummary();
    if (accounts.length === 0 || !active || active.status === "auth_failed") {
      this.statusBarItem.text = "$(account) AGY Swap";
      this.statusBarItem.tooltip = "Antigravity Swap: No active account. Click to connect or switch.";
      this.statusBarItem.backgroundColor = void 0;
      return;
    }
    const activePct = active.averageQuotaPercentage ?? 0;
    const overallPct = overall.overallPercentage ?? 0;
    let icon = "$(zap)";
    if (active.isBanned) {
      icon = "$(error)";
      this.statusBarItem.backgroundColor = new vscode4.ThemeColor("statusBarItem.errorBackground");
    } else if (activePct < 20) {
      icon = "$(warning)";
      this.statusBarItem.backgroundColor = new vscode4.ThemeColor("statusBarItem.warningBackground");
    } else {
      this.statusBarItem.backgroundColor = void 0;
    }
    const displayName = active.name ? active.name.split(" ")[0] : active.email.split("@")[0];
    this.statusBarItem.text = `${icon} ${displayName}: ${activePct}% | All: ${overallPct}%`;
    const lines = [
      `Antigravity Swap - Account & Quota Status`,
      `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
      `Active: ${active.name || active.email} (${active.email})`,
      `Active Account Quota: ${activePct}%`,
      `Overall Across ${overall.totalAccounts} Account(s): ${overallPct}%`,
      ``,
      `--- Model Quotas (${active.email}) ---`
    ];
    if (active.quotas && active.quotas.length > 0) {
      for (const q of active.quotas.slice(0, 6)) {
        const bar = this.getProgressBar(q.percentage);
        lines.push(`\u2022 ${q.displayName}: ${bar} ${q.percentage}% ${q.resetCountdown ? "(" + q.resetCountdown + ")" : ""}`);
      }
    }
    lines.push(``, `Click to switch accounts or open dashboard`);
    this.statusBarItem.tooltip = new vscode4.MarkdownString(lines.join("\n"));
  }
  getProgressBar(pct) {
    const filled = Math.round(pct / 20);
    const empty = 5 - filled;
    return "\u2588".repeat(filled) + "\u2591".repeat(Math.max(0, empty));
  }
  async showQuickMenu() {
    const accounts = this.accountManager.getAccounts();
    const active = this.accountManager.getActiveAccount();
    const overall = this.accountManager.getOverallSummary();
    const items = [];
    items.push({
      label: `Overall Quota: ${overall.overallPercentage}% across ${overall.totalAccounts} account(s)`,
      description: `Active: ${active ? active.email : "None"} (${active ? active.averageQuotaPercentage : 0}%)`,
      kind: vscode4.QuickPickItemKind.Separator
    });
    for (const acc of accounts) {
      const isAct = acc.email === active?.email && acc.isActive;
      let statusIcon = isAct ? "$(check)" : "$(account)";
      let statusExtra = "";
      if (acc.isBanned) {
        statusIcon = "$(error)";
        statusExtra = " [BANNED]";
      } else if (acc.status === "auth_failed") {
        statusIcon = "$(warning)";
        statusExtra = " [AUTH FAILED]";
      }
      const quotaPct = acc.averageQuotaPercentage ?? 0;
      const detailText = acc.isBanned ? "Account banned/disabled by Google TOS" : acc.status === "auth_failed" ? "Credentials expired. Click to re-login." : isAct ? "CURRENTLY ACTIVE" : "Click to switch without reloading";
      items.push({
        label: `${statusIcon} ${acc.name || acc.email}${statusExtra}`,
        description: `${acc.email} \u2014 ${acc.isBanned ? "0%" : quotaPct + "%"} quota left`,
        detail: detailText,
        buttons: [
          ...acc.isBanned || acc.status === "auth_failed" ? [
            {
              iconPath: new vscode4.ThemeIcon("key"),
              tooltip: "Re-login / Reconnect Account"
            }
          ] : [
            {
              iconPath: new vscode4.ThemeIcon("refresh"),
              tooltip: "Refresh quota"
            }
          ],
          {
            iconPath: new vscode4.ThemeIcon("trash"),
            tooltip: "Remove account"
          }
        ]
      });
    }
    items.push({
      label: "Actions",
      kind: vscode4.QuickPickItemKind.Separator
    });
    items.push({
      label: "$(cloud-download) Import Current Antigravity Session",
      description: "Import the active logged-in account from Antigravity IDE"
    });
    items.push({
      label: "$(add) Add Account (Google OAuth)",
      description: "Sign in with a new Google Account via browser"
    });
    items.push({
      label: "$(key) Add Account (Manual Token)",
      description: "Paste Access / Refresh Token directly"
    });
    items.push({
      label: "$(refresh) Refresh All Quotas Now",
      description: "Force immediate background quota check"
    });
    const quickPick = vscode4.window.createQuickPick();
    quickPick.title = "Antigravity Swap: Fast Account Switcher";
    quickPick.placeholder = "Select account to switch or choose an action";
    quickPick.items = items;
    quickPick.onDidTriggerItemButton(async (e) => {
      const targetEmail = e.item.description?.split(" \u2014 ")[0]?.trim();
      if (!targetEmail) return;
      const tooltip = e.button.tooltip;
      if (tooltip === "Re-login / Reconnect Account") {
        quickPick.hide();
        await this.accountManager.reloginAccount(targetEmail);
      } else if (tooltip === "Refresh quota") {
        await this.accountManager.refreshAccountQuota(targetEmail);
      } else if (tooltip === "Remove account") {
        const confirm = await vscode4.window.showWarningMessage(
          `Remove account ${targetEmail} from Antigravity Swap?`,
          { modal: true },
          "Remove"
        );
        if (confirm === "Remove") {
          await this.accountManager.removeAccount(targetEmail);
          quickPick.items = quickPick.items.filter((i) => !i.description?.startsWith(targetEmail));
        }
      }
    });
    quickPick.onDidChangeSelection(async (selection) => {
      if (selection.length === 0) return;
      quickPick.hide();
      const chosen = selection[0];
      if (chosen.label.includes("Import Current Antigravity Session")) {
        await this.accountManager.importCurrentAntigravityAccount();
      } else if (chosen.label.includes("Add Account (Google OAuth)")) {
        await this.accountManager.addAccountViaOAuth();
      } else if (chosen.label.includes("Add Account (Manual Token)")) {
        await vscode4.commands.executeCommand("antigravitySwap.addAccountManual");
      } else if (chosen.label.includes("Refresh All Quotas Now")) {
        await vscode4.commands.executeCommand("antigravitySwap.refreshQuotas");
      } else {
        const email = chosen.description?.split(" \u2014 ")[0]?.trim();
        if (email) {
          await this.accountManager.switchAccount(email);
        }
      }
    });
    quickPick.show();
  }
  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
};

// src/webviewProvider.ts
var vscode5 = __toESM(require("vscode"));
var WebviewProvider = class {
  constructor(extensionUri, accountManager, heartbeatService) {
    this.extensionUri = extensionUri;
    this.accountManager = accountManager;
    this.heartbeatService = heartbeatService;
    this.accountManager.onDidChangeState(() => this.updateWebview());
    this.heartbeatService.onHeartbeat(() => this.updateWebview());
  }
  static viewType = "antigravitySwap.dashboardView";
  _view;
  resolveWebviewView(webviewView, _context, _token) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = this.getHtmlContent(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async (data) => {
      console.log("[Antigravity Swap] Webview message:", data);
      try {
        switch (data.command) {
          case "switchAccount":
            await this.accountManager.switchAccount(data.email, data.isManual === true);
            break;
          case "reloginAccount":
            await this.accountManager.reloginAccount(data.email);
            break;
          case "refreshAll":
            await vscode5.commands.executeCommand("antigravitySwap.refreshQuotas");
            break;
          case "refreshAccount":
            await this.accountManager.refreshAccountQuota(data.email);
            break;
          case "addOAuth":
            await vscode5.commands.executeCommand("antigravitySwap.addAccount");
            break;
          case "importCurrentAntigravity":
            await this.accountManager.importCurrentAntigravityAccount();
            break;
          case "addManual":
            await vscode5.commands.executeCommand("antigravitySwap.addAccountManual");
            break;
          case "removeAccount":
            const confirm = await vscode5.window.showWarningMessage(
              `Remove account ${data.email} from Antigravity Swap?`,
              { modal: true },
              "Remove"
            );
            if (confirm === "Remove") {
              await this.accountManager.removeAccount(data.email);
            }
            break;
          case "setAutoSwitch":
            await this.accountManager.setAutoSwitchEnabled(data.enabled);
            break;
          case "ready":
            this.updateWebview();
            break;
        }
      } catch (err) {
        console.error("[Antigravity Swap] Webview command error:", err);
        vscode5.window.showErrorMessage(`Action failed: ${err.message}`);
      }
    });
    this.updateWebview();
  }
  updateWebview() {
    if (!this._view) return;
    const accounts = this.accountManager.getAccounts();
    const activeAccount = this.accountManager.getActiveAccount();
    const overall = this.accountManager.getOverallSummary();
    const heartbeat = this.heartbeatService.getHeartbeatInfo();
    this._view.webview.postMessage({
      type: "stateUpdate",
      accounts,
      activeAccount,
      overall,
      heartbeat,
      autoSwitchEnabled: this.accountManager.isAutoSwitchEnabled()
    });
  }
  getHtmlContent(_webview) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Antigravity Swap</title>
  <style>
    :root {
      --bg: #0b0f1a;
      --card-bg: rgba(20, 27, 45, 0.85);
      --card-border: rgba(59, 130, 246, 0.18);
      --card-border-active: rgba(96, 165, 250, 0.9);
      --card-border-selected: rgba(168, 85, 247, 0.8);
      --blue: #38bdf8;
      --purple: #a855f7;
      --pink: #ec4899;
      --green: #22c55e;
      --amber: #f59e0b;
      --red: #ef4444;
      --text: #f1f5f9;
      --muted: #64748b;
      --muted2: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 10px;
      font-size: 12px;
      line-height: 1.4;
      min-height: 100vh;
      user-select: none;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .spin-icon {
      display: inline-block;
      animation: spin 0.8s linear infinite;
    }

    .hero {
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(15, 23, 42, 0.98));
      border: 1px solid rgba(56, 189, 248, 0.25);
      border-radius: 14px;
      padding: 12px 14px;
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }
    .gauge {
      width: 60px;
      height: 60px;
      flex-shrink: 0;
      position: relative;
    }
    .gauge svg { transform: rotate(-90deg); }
    .gauge-bg { fill: none; stroke: rgba(255, 255, 255, 0.08); stroke-width: 5; }
    .gauge-fill {
      fill: none;
      stroke: url(#gg);
      stroke-width: 5;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.8s ease;
    }
    .gauge-label {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 14px;
      font-weight: 800;
      color: #fff;
    }
    .hero-body { flex: 1; min-width: 0; }
    .hero-tag {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--blue);
      font-weight: 700;
      margin-bottom: 1px;
    }
    .hero-title {
      font-size: 13px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .hero-pills { display: flex; flex-wrap: wrap; gap: 4px; }
    .pill {
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 999px;
      padding: 1px 7px;
      font-size: 10px;
      color: var(--muted2);
      white-space: nowrap;
    }
    .pill.pro {
      border-color: rgba(168, 85, 247, 0.4);
      color: var(--purple);
    }

    .quota-summary-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 10px;
    }
    .quota-summary-card {
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 10px;
      padding: 8px 10px;
    }
    .qs-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      font-weight: 700;
      margin-bottom: 4px;
    }
    .qs-pct {
      font-size: 18px;
      font-weight: 800;
      margin-bottom: 3px;
    }
    .qs-bar {
      height: 4px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      overflow: hidden;
    }
    .qs-bar-fill {
      height: 100%;
      border-radius: 999px;
      transition: width 0.6s ease;
    }

    /* Controller bar \u2014 flex-wrap row for all top action buttons */
    .ctrl-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-bottom: 10px;
    }
    .ctrl-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.15s ease;
      outline: none;
      font-family: inherit;
      white-space: nowrap;
    }
    .ctrl-btn-import  { background: linear-gradient(135deg, #0284c7, #0d9488); color: #fff; border-color: transparent; }
    .ctrl-btn-import:hover { filter: brightness(1.15); }
    .ctrl-btn-refresh { background: rgba(30, 41, 59, 0.9); color: #e2e8f0; border-color: rgba(255,255,255,0.1); }
    .ctrl-btn-refresh:hover { background: rgba(51, 65, 85, 0.9); }
    .ctrl-btn-signin  { background: linear-gradient(135deg, #2563eb, #7c3aed); color: #fff; border-color: transparent; }
    .ctrl-btn-signin:hover { filter: brightness(1.15); }
    /* Auto-switch inline toggle inside ctrl-bar */
    .ctrl-as {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 9px;
      border-radius: 8px;
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid rgba(255,255,255,0.09);
      cursor: pointer;
      font-size: 10px;
      font-weight: 600;
      color: var(--muted2);
      font-family: inherit;
      transition: border-color 0.15s;
    }
    .ctrl-as:hover { border-color: rgba(255,255,255,0.2); }
    .ctrl-as.active { border-color: rgba(3,105,161,0.6); color: #38bdf8; }
    .toggle-dot {
      width: 28px;
      height: 16px;
      border-radius: 999px;
      position: relative;
      transition: background 0.2s;
      flex-shrink: 0;
    }
    .toggle-dot.on  { background: #0369a1; }
    .toggle-dot.off { background: rgba(255,255,255,0.12); }
    .toggle-dot::after {
      content: '';
      position: absolute;
      top: 2px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #fff;
      transition: left 0.2s;
    }
    .toggle-dot.on::after  { left: 14px; }
    .toggle-dot.off::after { left: 2px; }

    .actions-grid {
      display: none; /* replaced by ctrl-bar */
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 8px 10px;
      border-radius: 9px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.18s ease;
      outline: none;
      text-align: center;
      font-family: inherit;
    }
    .btn-primary {
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      color: #fff;
    }
    .btn-primary:hover { filter: brightness(1.15); }
    .btn-import {
      background: linear-gradient(135deg, #0284c7, #0d9488);
      color: #fff;
    }
    .btn-import:hover { filter: brightness(1.15); }
    .btn-secondary {
      background: rgba(30, 41, 59, 0.9);
      color: #e2e8f0;
      border-color: rgba(255, 255, 255, 0.1);
    }
    .btn-secondary:hover { background: rgba(51, 65, 85, 0.9); border-color: rgba(255, 255, 255, 0.2); }
    .btn-relogin {
      background: linear-gradient(135deg, #d97706, #b45309);
      color: #fff;
      font-size: 10px;
      padding: 3px 8px;
      box-shadow: 0 2px 6px rgba(217, 119, 6, 0.35);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-family: inherit;
    }
    .btn-relogin:hover { filter: brightness(1.15); }
    .btn-switch {
      background: linear-gradient(135deg, #0284c7, #0369a1);
      color: #fff;
      font-size: 10px;
      padding: 3px 8px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 58px;
      justify-content: center;
    }
    .btn-switch:hover:not(:disabled) { filter: brightness(1.15); }
    .btn-switch:disabled { opacity: 0.75; cursor: not-allowed; }
    .btn-icon {
      padding: 4px 6px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.09);
      color: var(--muted2);
      cursor: pointer;
      font-size: 11px;
      font-family: inherit;
    }
    .btn-icon:hover { color: #fff; background: rgba(255, 255, 255, 0.12); }

    .section-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      font-weight: 700;
      margin: 10px 0 6px 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .acc-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 8px;
      margin-bottom: 14px;
    }
    /* BASE / NORMAL STATE (UNSELECTED NON-ACTIVE) */
    .acc-card {
      background: hsl(220, 24%, 12%);
      border: 1px solid hsla(220, 20%, 24%, 0.6);
      border-radius: 12px;
      padding: 10px;
      transition: background 0.15s ease, border-color 0.15s ease, transform 0.08s ease, box-shadow 0.15s ease;
      position: relative;
      overflow: hidden;
      cursor: pointer;
    }

    /* SELECTED NON-ACTIVE: Neutral lifted slate card with crisp subtle border (no cyan tint) */
    .acc-card.selected:not(.active) {
      background: hsl(220, 22%, 16%);
      border: 1.5px solid hsla(220, 20%, 55%, 0.45);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    }

    /* HOVER STATE: subtle gentle lift in lightness */
    .acc-card:not(.active):hover {
      background: hsl(220, 24%, 18%);
      border-color: hsla(220, 25%, 65%, 0.6);
    }

    /* CSS :ACTIVE (MOUSEDOWN / CLICK): micro feedback */
    .acc-card:not(.active):active {
      background: hsl(220, 26%, 21%);
      border-color: hsla(220, 30%, 75%, 0.75);
      transform: scale(0.996);
    }

    /* ACTIVE ACCOUNT (NORMAL / UNSELECTED): Subdued navy with distinct cyan indicator bar */
    .acc-card.active:not(.selected) {
      background: hsl(212, 38%, 14%);
      border: 1.5px solid hsla(200, 55%, 38%, 0.45);
    }
    .acc-card.active::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 3px;
      height: 100%;
      background: linear-gradient(to bottom, #38bdf8, #818cf8);
    }

    /* ACTIVE ACCOUNT (SELECTED): Vivid active navy with luminous cyan border */
    .acc-card.active.selected {
      background: hsl(212, 45%, 18%);
      border: 1.5px solid hsla(200, 80%, 55%, 0.75);
      box-shadow: 0 4px 12px hsla(200, 70%, 25%, 0.25);
    }

    /* ACTIVE ACCOUNT (HOVER): Gentle highlight */
    .acc-card.active:hover {
      background: hsl(212, 48%, 21%);
      border-color: hsla(200, 85%, 65%, 0.85);
    }

    /* ACTIVE ACCOUNT CSS :ACTIVE (MOUSEDOWN / CLICK) */
    .acc-card.active:active {
      background: hsl(212, 52%, 24%);
      border-color: hsla(200, 90%, 72%, 0.95);
      transform: scale(0.996);
    }

    .acc-card.banned {
      border-color: rgba(239, 68, 68, 0.5);
      background: rgba(60, 12, 12, 0.45);
    }
    .acc-card.banned.selected {
      border-color: rgba(239, 68, 68, 0.8);
      background: rgba(80, 16, 16, 0.6);
      box-shadow: 0 4px 14px rgba(239, 68, 68, 0.2);
    }
    .acc-card.banned:hover {
      border-color: rgba(239, 68, 68, 0.95);
      background: rgba(95, 20, 20, 0.7);
    }
    .acc-card.banned:active {
      background: rgba(115, 24, 24, 0.85);
      transform: scale(0.985);
    }

    .acc-card.auth-failed {
      border-color: rgba(245, 158, 11, 0.4);
      background: rgba(45, 30, 10, 0.45);
    }
    .acc-card.auth-failed.selected {
      border-color: rgba(245, 158, 11, 0.75);
      background: rgba(65, 42, 12, 0.6);
      box-shadow: 0 4px 14px rgba(245, 158, 11, 0.2);
    }
    .acc-card.auth-failed:hover {
      border-color: rgba(245, 158, 11, 0.9);
      background: rgba(80, 52, 15, 0.7);
    }
    .acc-card.auth-failed:active {
      background: rgba(95, 62, 18, 0.85);
      transform: scale(0.985);
    }

    .acc-top {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .acc-avatar {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: linear-gradient(135deg, #3b82f6, #ec4899);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      color: #fff;
      font-size: 12px;
      flex-shrink: 0;
      border: 1.5px solid rgba(255, 255, 255, 0.18);
      overflow: hidden;
    }
    .acc-avatar img { width: 100%; height: 100%; object-fit: cover; }
    .acc-info { flex: 1; min-width: 0; }
    .acc-name-row {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-wrap: wrap;
      margin-bottom: 1px;
      padding-right: 52px;
    }
    .acc-name {
      font-weight: 700;
      font-size: 12px;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .acc-email {
      font-size: 10px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .acc-status-msg {
      font-size: 10px;
      color: var(--amber);
      margin-top: 2px;
    }

    .badge {
      font-size: 8px;
      font-weight: 800;
      padding: 1px 5px;
      border-radius: 4px;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }
    .badge-active     { background: #0369a1; color: #fff; }
    .badge-banned     { background: #dc2626; color: #fff; }
    .badge-auth       { background: #b45309; color: #fff; }
    .badge-pro        { background: linear-gradient(90deg, #7c3aed, #ec4899); color: #fff; }
    .badge-premium    { background: linear-gradient(90deg, #0284c7, #7c3aed); color: #fff; }
    .badge-enterprise { background: linear-gradient(90deg, #065f46, #0369a1); color: #fff; }
    .badge-selected {
      position: absolute;
      top: 7px;
      right: 8px;
      font-size: 9px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 4px;
      letter-spacing: 0;
      background: rgba(255, 255, 255, 0.12);
      border: 1px solid rgba(255, 255, 255, 0.28);
      color: rgba(255, 255, 255, 0.9);
      pointer-events: none;
    }

    .acc-quota-section { margin-top: 6px; }
    .acc-quota-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 5px;
    }
    .qtab {
      flex: 1;
      text-align: center;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      padding: 3px 4px;
    }
    .qtab-label {
      color: var(--muted);
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .qtab-val {
      font-weight: 800;
      font-size: 13px;
      margin-top: 1px;
    }
    .bar-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .bar-bg {
      flex: 1;
      height: 5px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      border-radius: 999px;
      transition: width 0.6s ease;
    }
    .bar-pct {
      font-size: 10px;
      font-weight: 700;
      width: 32px;
      text-align: right;
    }
    .fill-green { background: linear-gradient(90deg, #10b981, #22c55e); }
    .fill-amber { background: linear-gradient(90deg, #d97706, #f59e0b); }
    .fill-red   { background: linear-gradient(90deg, #dc2626, #ef4444); }

    .acc-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 5px;
      margin-top: 7px;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }
    .acc-type-label {
      flex: 1;
      font-size: 10px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .model-section { margin-bottom: 14px; }
    .model-window-group { margin-bottom: 10px; }
    .model-window-title {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      font-weight: 700;
      margin-bottom: 5px;
    }
    .model-cards {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .model-card {
      background: rgba(13, 18, 32, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 8px;
      padding: 7px 10px;
    }
    .model-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .model-name { font-weight: 600; font-size: 11px; color: #e2e8f0; }
    .model-reset { font-size: 9px; color: var(--muted); }

    .empty {
      text-align: center;
      padding: 24px 12px;
      background: var(--card-bg);
      border: 1px dashed rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      margin-bottom: 12px;
    }
    .empty-icon { font-size: 28px; margin-bottom: 8px; }
    .empty-text { color: var(--muted2); font-size: 11px; margin-bottom: 12px; }

    .notice-box {
      padding: 10px 12px;
      border-radius: 8px;
      text-align: center;
      font-size: 11px;
      line-height: 1.5;
    }
    .notice-auth {
      background: rgba(217, 119, 6, 0.12);
      border: 1px dashed rgba(217, 119, 6, 0.35);
      color: var(--amber);
    }
    .notice-ban {
      background: rgba(239, 68, 68, 0.12);
      border: 1px dashed rgba(239, 68, 68, 0.35);
      color: var(--red);
    }
    .notice-info {
      background: rgba(255, 255, 255, 0.04);
      border: 1px dashed rgba(255, 255, 255, 0.1);
      color: var(--muted);
    }

    /* Auto-switch toggle row */
    .auto-switch-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 8px;
      padding: 6px 10px;
      margin-bottom: 8px;
      gap: 8px;
    }
    .auto-switch-label {
      font-size: 10px;
      color: var(--muted2);
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 5px;
      flex: 1;
    }
    .auto-switch-label .as-title { color: var(--text); font-weight: 700; }
    .toggle-pill {
      width: 36px;
      height: 20px;
      border-radius: 999px;
      border: none;
      cursor: pointer;
      position: relative;
      transition: background 0.2s ease;
      flex-shrink: 0;
      outline: none;
    }
    .toggle-pill.on  { background: #0369a1; }
    .toggle-pill.off { background: rgba(255, 255, 255, 0.12); }
    .toggle-pill::after {
      content: '';
      position: absolute;
      top: 3px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #fff;
      transition: left 0.2s ease;
    }
    .toggle-pill.on::after  { left: 19px; }
    .toggle-pill.off::after { left: 3px; }
  </style>
</head>
<body>

  <!-- Top Hero Card -->
  <div class="hero">
    <div class="gauge">
      <svg width="60" height="60" viewBox="0 0 60 60">
        <defs>
          <linearGradient id="gg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%"   stop-color="#38bdf8"/>
            <stop offset="50%"  stop-color="#818cf8"/>
            <stop offset="100%" stop-color="#ec4899"/>
          </linearGradient>
        </defs>
        <circle class="gauge-bg" cx="30" cy="30" r="26"/>
        <circle id="overall-gauge" class="gauge-fill" cx="30" cy="30" r="26"
          stroke-dasharray="163.4" stroke-dashoffset="163.4"/>
      </svg>
      <div id="overall-pct-label" class="gauge-label">0%</div>
    </div>
    <div class="hero-body">
      <div class="hero-tag">&#9889; Antigravity Swap</div>
      <div id="hero-title" class="hero-title">Overall Quota</div>
      <div class="hero-pills">
        <span id="pill-accounts" class="pill">0 Accounts</span>
        <span id="pill-healthy"  class="pill">0 Healthy</span>
        <span id="pill-pro"      class="pill pro" style="display:none">0 Pro</span>
      </div>
    </div>
  </div>

  <!-- 5-Hour and Weekly Overall Cards -->
  <div class="quota-summary-row">
    <div class="quota-summary-card">
      <div class="qs-label">&#9201; 5h Window</div>
      <div id="qs-5h-pct" class="qs-pct" style="color:var(--blue)">&mdash;</div>
      <div class="qs-bar"><div id="qs-5h-bar" class="qs-bar-fill fill-green" style="width:0%"></div></div>
    </div>
    <div class="quota-summary-card">
      <div class="qs-label">&#128197; Weekly</div>
      <div id="qs-wk-pct" class="qs-pct" style="color:var(--purple)">&mdash;</div>
      <div class="qs-bar"><div id="qs-wk-bar" class="qs-bar-fill" style="width:0%;background:linear-gradient(90deg,#7c3aed,#a855f7)"></div></div>
    </div>
  </div>


  <!-- Controller Bar: all top action buttons in one flex-wrap row -->
  <div class="ctrl-bar">
    <button class="ctrl-btn ctrl-btn-import" id="btn-import-top">&#9889; Import Antigravity</button>
    <button class="ctrl-btn ctrl-btn-refresh" id="btn-refresh-top">&#8635; Refresh Quotas</button>
    <button class="ctrl-btn ctrl-btn-signin" id="btn-oauth-top">+ Google Sign In</button>
    <button class="ctrl-as off" id="btn-auto-switch" title="Toggle auto-switch when quota is low">
      <span class="toggle-dot off" id="as-dot"></span>Auto-Switch
    </button>
  </div>

  <!-- Accounts Section -->
  <div class="section-label">
    <span>Accounts &amp; Fast Switch</span>
    <button class="btn-icon" id="btn-manual-top" title="Add via token">+ Manual</button>
  </div>
  <div id="acc-container" class="acc-list"></div>

  <!-- Model Breakdown Section -->
  <div class="section-label">
    <span id="models-title">Model Quotas</span>
  </div>
  <div id="models-container" class="model-section"></div>

<script>
(function() {
  const vscode = acquireVsCodeApi();
  const CIRC = 2 * Math.PI * 26;

  let currentAccounts = [];
  let currentActive = null;
  let selectedEmail = null;

  document.getElementById('btn-import-top').addEventListener('click', function() {
    vscode.postMessage({ command: 'importCurrentAntigravity' });
  });

  document.getElementById('btn-refresh-top').addEventListener('click', function() {
    const btn = document.getElementById('btn-refresh-top');
    if (btn) {
      btn.innerHTML = '<span class="spin-icon">&#8635;</span> Refreshing...';
      btn.disabled = true;
    }
    vscode.postMessage({ command: 'refreshAll' });
  });

  document.getElementById('btn-oauth-top').addEventListener('click', function() {
    vscode.postMessage({ command: 'addOAuth' });
  });

  document.getElementById('btn-manual-top').addEventListener('click', function() {
    vscode.postMessage({ command: 'addManual' });
  });

  var autoSwitchBtn = document.getElementById('btn-auto-switch');
  var asDot = document.getElementById('as-dot');
  autoSwitchBtn.addEventListener('click', function() {
    var nowEnabled = autoSwitchBtn.classList.contains('off');
    setAutoSwitchUi(nowEnabled);
    vscode.postMessage({ command: 'setAutoSwitch', enabled: nowEnabled });
  });

  function setAutoSwitchUi(enabled) {
    if (enabled) {
      autoSwitchBtn.classList.remove('off');
      autoSwitchBtn.classList.add('active');
      if (asDot) { asDot.classList.remove('off'); asDot.classList.add('on'); }
    } else {
      autoSwitchBtn.classList.remove('active');
      autoSwitchBtn.classList.add('off');
      if (asDot) { asDot.classList.remove('on'); asDot.classList.add('off'); }
    }
  }

  window.addEventListener('message', function(ev) {
    if (ev.data && ev.data.type === 'stateUpdate') {
      renderState(ev.data);
    }
  });

  function fillClass(p) { return p > 50 ? 'fill-green' : p > 20 ? 'fill-amber' : 'fill-red'; }
  function pctColor(p)  { return p > 50 ? 'var(--green)' : p > 20 ? 'var(--amber)' : 'var(--red)'; }

  function renderState(state) {
    const refreshTop = document.getElementById('btn-refresh-top');
    if (refreshTop) {
      refreshTop.innerHTML = '&#8635; Refresh Quotas';
      refreshTop.disabled = false;
    }

    const overall  = state.overall  || {};
    currentAccounts = state.accounts || [];
    currentActive   = state.activeAccount || null;

    // Sync auto-switch toggle from real state
    setAutoSwitchUi(state.autoSwitchEnabled !== false);

    // Preserve selection or default to active account
    if (!selectedEmail || !currentAccounts.some(function(a) { return a.email === selectedEmail; })) {
      selectedEmail = currentActive ? currentActive.email : (currentAccounts[0] ? currentAccounts[0].email : null);
    }

    const pct = overall.overallPercentage || 0;
    document.getElementById('overall-pct-label').innerText = pct + '%';
    document.getElementById('overall-gauge').style.strokeDashoffset = CIRC - (pct / 100) * CIRC;
    const healthyAccounts = currentAccounts.filter(function(a) {
      return !a.isBanned && a.status !== 'banned' && a.status !== 'auth_failed';
    });
    document.getElementById('pill-accounts').innerText = currentAccounts.length + ' Account' + (currentAccounts.length !== 1 ? 's' : '');
    document.getElementById('pill-healthy').innerText  = healthyAccounts.length + ' Healthy';

    const proEl = document.getElementById('pill-pro');
    if ((overall.proAccountsCount || 0) > 0) {
      proEl.style.display = '';
      proEl.innerText = overall.proAccountsCount + ' Pro';
    } else {
      proEl.style.display = 'none';
    }

    const fhPct = overall.overall5HourPercentage;
    const wkPct = overall.overallWeeklyPercentage;
    if (fhPct != null && (overall.proAccountsCount || 0) > 0) {
      document.getElementById('qs-5h-pct').innerText = fhPct + '%';
      document.getElementById('qs-5h-bar').style.width = (fhPct || 0) + '%';
      document.getElementById('qs-5h-bar').className = 'qs-bar-fill ' + fillClass(fhPct || 0);
    } else {
      document.getElementById('qs-5h-pct').innerText = 'N/A';
      document.getElementById('qs-5h-bar').style.width = '0%';
    }

    if (wkPct != null && wkPct > 0) {
      document.getElementById('qs-wk-pct').innerText = wkPct + '%';
      document.getElementById('qs-wk-bar').style.width = (wkPct || 0) + '%';
    } else {
      document.getElementById('qs-wk-pct').innerText = 'N/A';
      document.getElementById('qs-wk-bar').style.width = '0%';
    }

    const container = document.getElementById('acc-container');
    if (currentAccounts.length === 0) {
      container.innerHTML = '<div class="empty">' +
        '<div class="empty-icon">&#9889;</div>' +
        '<div class="empty-text">No accounts connected. Import from current Antigravity or sign in!</div>' +
        '<button class="btn btn-import" id="btn-empty-import" style="margin-bottom:6px;">&#9889; Import Antigravity Account</button>' +
        '<div><button class="btn btn-primary" id="btn-empty-oauth">+ Google Sign In</button></div>' +
        '</div>';
      const emptyImp = document.getElementById('btn-empty-import');
      if (emptyImp) emptyImp.onclick = function() { vscode.postMessage({ command: 'importCurrentAntigravity' }); };
      const emptyOauth = document.getElementById('btn-empty-oauth');
      if (emptyOauth) emptyOauth.onclick = function() { vscode.postMessage({ command: 'addOAuth' }); };
    } else {
      container.innerHTML = currentAccounts.map(function(acc) {
        return renderAccountCard(acc, currentActive, selectedEmail);
      }).join('');
      attachAccountEvents(container);
    }

    const selectedAcc = currentAccounts.find(function(a) { return a.email === selectedEmail; }) || currentActive;
    renderModelSection(selectedAcc, currentActive);
  }

  function tierBadgeHtml(acc) {
    const tier = acc.tierBadge;
    if (!tier || tier === 'STANDARD FREE') return '';
    if (tier === 'ENTERPRISE') return '<span class="badge badge-enterprise">ENTERPRISE</span>';
    if (tier === 'AI PREMIUM') return '<span class="badge badge-premium">AI PREMIUM</span>';
    if (tier === 'PRO')        return '<span class="badge badge-pro">PRO</span>';
    return '';
  }

  function renderAccountCard(acc, active, selected) {
    const isActive     = active && active.email === acc.email;
    const isSelected   = selected && selected === acc.email;
    const isBanned     = acc.isBanned || acc.status === 'banned';
    const isAuthFailed = acc.status === 'auth_failed';
    const pct          = acc.averageQuotaPercentage || 0;
    const fhPct        = acc.fiveHourQuotaPercentage;
    const wkPct        = acc.weeklyQuotaPercentage;
    const hasWk        = acc.hasWeeklyQuota;
    const isFree       = !acc.tierBadge || acc.tierBadge === 'STANDARD FREE';
    const fc           = fillClass(pct);
    const avatar       = acc.avatarUrl
      ? '<img src="' + acc.avatarUrl + '" alt="' + (acc.name || '') + '">'
      : (acc.name ? acc.name[0].toUpperCase() : acc.email[0].toUpperCase());

    let badges = '';
    if (isActive) {
      badges += '<span class="badge badge-active">ACTIVE</span>';
    }
    if (isBanned) {
      badges += '<span class="badge badge-banned">&#9940; BANNED</span>';
    } else if (isAuthFailed) {
      badges += '<span class="badge badge-auth">&#9888; AUTH FAILED</span>';
    }
    badges += tierBadgeHtml(acc);

    let cardClass = 'acc-card';
    if (isActive)      cardClass += ' active';
    if (isSelected)    cardClass += ' selected';
    if (isBanned)      cardClass += ' banned';
    if (isAuthFailed)  cardClass += ' auth-failed';

    let quotaHtml = '';
    if (isBanned) {
      quotaHtml = '<div style="color:var(--red);font-size:11px;padding:3px 0;font-weight:500;">&#9940; Account banned / suspended. Quota unavailable.</div>';
    } else if (isAuthFailed) {
      quotaHtml = '<div style="color:var(--amber);font-size:11px;padding:3px 0;font-weight:500;">&#9888; Authentication required. Click Re-login to load quotas.</div>';
    } else if (!isFree && hasWk && fhPct != null && wkPct != null) {
      quotaHtml = '<div class="acc-quota-tabs">' +
        '<div class="qtab"><div class="qtab-label">&#9201; 5h Window</div><div class="qtab-val" style="color:' + pctColor(fhPct) + '">' + fhPct + '%</div></div>' +
        '<div class="qtab"><div class="qtab-label">&#128197; Weekly</div><div class="qtab-val" style="color:' + pctColor(wkPct) + '">' + wkPct + '%</div></div>' +
        '</div>' +
        '<div class="bar-row"><div class="bar-bg"><div class="bar-fill ' + fc + '" style="width:' + pct + '%"></div></div><span class="bar-pct" style="color:' + pctColor(pct) + '">' + pct + '%</span></div>';
    } else {
      const label = (!isFree && fhPct != null) ? '&#9201; 5h: ' + fhPct + '%' : (hasWk && wkPct != null ? '&#128197; Weekly: ' + wkPct + '%' : 'Quota Remaining: ' + pct + '%');
      quotaHtml = '<div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:3px;"><span style="color:var(--muted)">' + label + '</span><span style="font-weight:700;color:' + pctColor(pct) + '">' + pct + '%</span></div>' +
        '<div class="bar-row"><div class="bar-bg"><div class="bar-fill ' + fc + '" style="width:' + pct + '%"></div></div></div>';
    }

    const switchBtn = (!isActive && !isBanned && !isAuthFailed)
      ? '<button class="btn-switch btn-action-switch" data-email="' + acc.email + '">Switch</button>'
      : '';

    // Only show re-login button for auth_failed accounts! Healthy accounts do not need it.
    const reloginBtn = isAuthFailed
      ? '<button class="btn-relogin btn-action-relogin" data-email="' + acc.email + '">&#128273; Re-login</button>'
      : '';

    const selectedBadge = isSelected ? '<span class="badge-selected">Selected</span>' : '';

    return '<div class="' + cardClass + '" data-card-email="' + acc.email + '">' +
      selectedBadge +
      '<div class="acc-top">' +
        '<div class="acc-avatar">' + avatar + '</div>' +
        '<div class="acc-info">' +
          '<div class="acc-name-row"><span class="acc-name">' + (acc.name || acc.email) + '</span>' + badges + '</div>' +
          '<div class="acc-email">' + acc.email + '</div>' +
          (acc.statusMessage ? '<div class="acc-status-msg">' + acc.statusMessage + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="acc-quota-section">' + quotaHtml + '</div>' +
      '<div class="acc-actions">' +
        '<span class="acc-type-label">' + (acc.accountType || 'Standard Free') + '</span>' +
        reloginBtn +
        '<button class="btn-icon btn-action-refresh" data-email="' + acc.email + '" title="Refresh quota">&#8635;</button>' +
        '<button class="btn-icon btn-action-remove" data-email="' + acc.email + '" title="Remove">&#128465;</button>' +
        switchBtn +
      '</div>' +
    '</div>';
  }

  function attachAccountEvents(container) {
    // Clicking on account card SELECTS that account (does NOT auto-switch)
    container.querySelectorAll('.acc-card').forEach(function(card) {
      card.addEventListener('click', function(e) {
        if (e.target.closest('button')) return;
        const email = card.getAttribute('data-card-email');
        if (!email) return;

        selectedEmail = email;

        // Update selected class and badge instantly
        container.querySelectorAll('.acc-card').forEach(function(c) {
          const isThis = c.getAttribute('data-card-email') === email;
          c.classList.toggle('selected', isThis);
          let b = c.querySelector('.badge-selected');
          if (isThis && !b) {
            const badgeSpan = document.createElement('span');
            badgeSpan.className = 'badge-selected';
            badgeSpan.innerText = 'Selected';
            c.insertBefore(badgeSpan, c.firstChild);
          } else if (!isThis && b) {
            b.remove();
          }
        });

        const targetAcc = currentAccounts.find(function(a) { return a.email === email; });
        if (targetAcc) {
          renderModelSection(targetAcc, currentActive);
        }
      });
    });

    // ONLY Switch button triggers account switch and shows rotating spinner
    container.querySelectorAll('.btn-action-switch').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const email = btn.getAttribute('data-email');
        if (email) {
          btn.disabled = true;
          btn.innerHTML = '<span class="spin-icon">&#8635;</span> Switching...';
          vscode.postMessage({ command: 'switchAccount', email: email, isManual: true });
        }
      });
    });

    container.querySelectorAll('.btn-action-relogin').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const email = btn.getAttribute('data-email');
        if (email) vscode.postMessage({ command: 'reloginAccount', email: email });
      });
    });

    container.querySelectorAll('.btn-action-refresh').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const email = btn.getAttribute('data-email');
        if (email) {
          btn.innerHTML = '<span class="spin-icon">&#8635;</span>';
          vscode.postMessage({ command: 'refreshAccount', email: email });
        }
      });
    });

    container.querySelectorAll('.btn-action-remove').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const email = btn.getAttribute('data-email');
        if (email) vscode.postMessage({ command: 'removeAccount', email: email });
      });
    });
  }

  function renderModelSection(target, active) {
    const title = document.getElementById('models-title');
    const container = document.getElementById('models-container');

    if (!target) {
      title.innerText = 'Model Quotas';
      container.innerHTML = '<div class="notice-box notice-info">Select an account above to view model quotas.</div>';
      return;
    }

    const isCurrentActive = active && active.email === target.email;
    const labelSuffix = isCurrentActive ? ' (Active)' : ' (Selected)';
    title.innerText = 'Model Quotas \xB7 ' + (target.name || target.email.split('@')[0]) + labelSuffix;

    if (target.status === 'auth_failed') {
      container.innerHTML = '<div class="notice-box notice-auth">&#9888; Credentials expired or missing for <strong>' + (target.name || target.email) + '</strong>.<br>Click <strong>Re-login</strong> or <strong>Import Antigravity</strong> to authenticate and load quotas.</div>';
      return;
    }

    if (target.isBanned || target.status === 'banned') {
      container.innerHTML = '<div class="notice-box notice-ban">&#9940; Account <strong>' + (target.name || target.email) + '</strong> is suspended by Google Terms of Service.<br>Model quotas are inaccessible.</div>';
      return;
    }

    if (!target.quotas || target.quotas.length === 0) {
      container.innerHTML = '<div class="notice-box notice-info">No quota breakdown loaded for this account.<br>Click <strong>&#8635; Refresh Quotas</strong> to query server.</div>';
      return;
    }

    // Filter out fast autocomplete and thinking effort - only show primary AI models
    const validQuotas = target.quotas.filter(function(q) {
      const s = (q.id + ' ' + (q.displayName || '')).toLowerCase();
      return (
        !s.includes('tab_') &&
        !s.includes('autocomplete') &&
        !s.includes('tab completion') &&
        !s.includes('thinking effort') &&
        !s.includes('thinking_effort') &&
        !s.includes('thinking-effort') &&
        !s.includes('thinking budget') &&
        !s.includes('thinking_budget') &&
        !s.includes('thinking-budget')
      );
    });

    function getModelRank(q) {
      const s = (q.id + ' ' + (q.displayName || '')).toLowerCase();
      if (s.includes('3.8-flash') || s.includes('3.8 flash')) return 10;
      if (s.includes('3.7-flash') || s.includes('3.7 flash')) return 20;
      if (s.includes('3.6-flash') || s.includes('3.6 flash')) return 30;
      if (s.includes('3.1-flash') || s.includes('3.1 flash')) return 40;
      if (s.includes('3.5-flash') || s.includes('3.5 flash')) return 45; // fallback
      if (s.includes('gemini-3-flash') || s.includes('gemini 3 flash') || s.includes('gemini-3.0-flash')) return 50;
      if (s.includes('gemini') && s.includes('flash')) return 60;
      if (s.includes('gemini') && s.includes('pro')) return 70;
      if (s.includes('gemini')) return 80;
      if (s.includes('claude') && (s.includes('sonnet-4-6') || s.includes('sonnet 4.6') || s.includes('sonnet'))) return 100;
      if (s.includes('claude') && (s.includes('opus-4-6') || s.includes('opus 4.6') || s.includes('opus'))) return 110;
      if (s.includes('claude')) return 130;
      if (s.includes('gpt-oss') || s.includes('gpt_oss') || s.includes('gpt oss')) return 200;
      return 500;
    }


    const isFree = !target.tierBadge || target.tierBadge === 'STANDARD FREE';
    const sortedQuotas = [...validQuotas].sort(function(a, b) { return getModelRank(a) - getModelRank(b); });

    let html = '';
    if (isFree) {
      html += renderModelGroup('Standard Model Quotas', sortedQuotas);
    } else {
      const fiveHour = sortedQuotas.filter(function(q) { return q.windowType === '5h'; });
      const weekly   = sortedQuotas.filter(function(q) { return q.windowType === 'weekly'; });
      const other    = sortedQuotas.filter(function(q) { return q.windowType !== '5h' && q.windowType !== 'weekly'; });

      if (fiveHour.length > 0) html += renderModelGroup('&#9201; 5-Hour Rolling Window', fiveHour);
      if (weekly.length   > 0) html += renderModelGroup('&#128197; Weekly Plan Quota', weekly);
      if (other.length    > 0) html += renderModelGroup('&#128202; Additional Models', other);
    }

    container.innerHTML = html || '<div class="notice-box notice-info">No model quotas available for this account.</div>';
  }

  function renderModelGroup(groupTitle, quotas) {
    const cards = quotas.map(function(q) {
      // Sentinel value -1 means free tier placeholder (no API quota data)
      const isFreePlaceholder = q.percentage === -1 || q.remainingFraction === -1;
      if (isFreePlaceholder) {
        return '<div class="model-card">' +
          '<div class="model-top"><span class="model-name">' + q.displayName + '</span>' +
          '<span class="model-reset" style="color:var(--green);font-weight:600;">Free Tier</span></div>' +
          '<div style="font-size:10px;color:var(--muted);margin-top:2px;font-style:italic;">Quota data not exposed by API for free accounts</div>' +
          '</div>';
      }
      const fc = fillClass(q.percentage);
      const pctCol = pctColor(q.percentage);
      const resetHtml = q.resetCountdown ? '<span class="model-reset">Resets ' + q.resetCountdown + '</span>' : '';
      return '<div class="model-card">' +
        '<div class="model-top"><span class="model-name">' + q.displayName + '</span>' + resetHtml + '</div>' +
        '<div class="bar-row"><div class="bar-bg"><div class="bar-fill ' + fc + '" style="width:' + q.percentage + '%"></div></div><span class="bar-pct" style="color:' + pctCol + '">' + q.percentage + '%</span></div>' +
        '</div>';
    }).join('');
    return '<div class="model-window-group"><div class="model-window-title">' + groupTitle + '</div><div class="model-cards">' + cards + '</div></div>';
  }


  vscode.postMessage({ command: 'ready' });
})();
</script>
</body>
</html>`;
  }
};

// src/heartbeatService.ts
var vscode6 = __toESM(require("vscode"));
var HeartbeatService = class {
  constructor(accountManager) {
    this.accountManager = accountManager;
  }
  timer;
  intervalSeconds = 30;
  isRunning = false;
  lastTick = (/* @__PURE__ */ new Date()).toISOString();
  _onHeartbeat = new vscode6.EventEmitter();
  onHeartbeat = this._onHeartbeat.event;
  start(intervalSeconds = 30) {
    this.intervalSeconds = intervalSeconds;
    this.stop();
    this.isRunning = true;
    setTimeout(() => {
      this.tick();
    }, 2e3);
    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalSeconds * 1e3);
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = void 0;
    }
    this.isRunning = false;
  }
  async tick() {
    this.lastTick = (/* @__PURE__ */ new Date()).toISOString();
    try {
      await this.accountManager.runHeartbeatTick();
    } catch (err) {
      console.warn("[HeartbeatService] Tick error:", err);
    }
    const active = this.accountManager.getActiveAccount();
    let health = "healthy";
    if (!active || active.isBanned || active.status === "auth_failed" || active.status === "banned") {
      health = "error";
    } else if (active.status === "low_balance" || active.averageQuotaPercentage < 15) {
      health = "warning";
    }
    this._onHeartbeat.fire({
      lastTick: this.lastTick,
      intervalSeconds: this.intervalSeconds,
      isRunning: this.isRunning,
      activeAccountHealth: health
    });
  }
  getHeartbeatInfo() {
    const active = this.accountManager.getActiveAccount();
    let health = "healthy";
    if (!active || active.isBanned || active.status === "auth_failed" || active.status === "banned") {
      health = "error";
    } else if (active.status === "low_balance" || active.averageQuotaPercentage < 15) {
      health = "warning";
    }
    return {
      lastTick: this.lastTick,
      intervalSeconds: this.intervalSeconds,
      isRunning: this.isRunning,
      activeAccountHealth: health
    };
  }
  dispose() {
    this.stop();
    this._onHeartbeat.dispose();
  }
};

// src/extension.ts
async function activate(context) {
  console.log("[Antigravity Swap] Activating extension with Heartbeat & Ban detection...");
  const storageService = new StorageService(context, context.secrets);
  const oauthService = new OAuthService();
  const quotaService = new QuotaService(oauthService);
  const accountManager = new AccountManager(storageService, oauthService, quotaService);
  const heartbeatService = new HeartbeatService(accountManager);
  await accountManager.initialize();
  const config = vscode7.workspace.getConfiguration("antigravitySwap");
  const heartbeatSec = config.get("heartbeatIntervalSeconds", 30);
  heartbeatService.start(heartbeatSec);
  context.subscriptions.push(heartbeatService);
  const webviewProvider = new WebviewProvider(context.extensionUri, accountManager, heartbeatService);
  context.subscriptions.push(
    vscode7.window.registerWebviewViewProvider(WebviewProvider.viewType, webviewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  const statusBar = new StatusBarService(accountManager);
  context.subscriptions.push(statusBar);
  context.subscriptions.push(
    vscode7.commands.registerCommand("antigravitySwap.openQuickMenu", async () => {
      await statusBar.showQuickMenu();
    }),
    vscode7.commands.registerCommand("antigravitySwap.switchAccount", async (emailArg) => {
      if (emailArg && typeof emailArg === "string") {
        await accountManager.switchAccount(emailArg);
        return;
      }
      const accounts = accountManager.getAccounts();
      if (accounts.length === 0) {
        const addChoice = await vscode7.window.showInformationMessage(
          "No accounts in Antigravity Swap. Add your first account now?",
          "Sign in with Google",
          "Cancel"
        );
        if (addChoice === "Sign in with Google") {
          await accountManager.addAccountViaOAuth();
        }
        return;
      }
      const items = accounts.map((a) => {
        let statusBadge = "";
        if (a.isBanned) statusBadge = " [\u26D4 BANNED]";
        else if (a.status === "auth_failed") statusBadge = " [\u26A0\uFE0F AUTH FAILED]";
        return {
          label: `${a.isActive ? "$(check) " : ""}${a.name || a.email}${statusBadge}`,
          description: `${a.email} (${a.averageQuotaPercentage}% quota left)`,
          email: a.email
        };
      });
      const pick = await vscode7.window.showQuickPick(items, {
        placeHolder: "Select account to switch without reload"
      });
      if (pick) {
        await accountManager.switchAccount(pick.email);
      }
    }),
    vscode7.commands.registerCommand("antigravitySwap.reloginAccount", async (emailArg) => {
      let email = emailArg;
      if (!email) {
        const accounts = accountManager.getAccounts();
        const pick = await vscode7.window.showQuickPick(
          accounts.map((a) => ({
            label: `${a.isBanned ? "\u26D4 " : ""}${a.email}`,
            description: a.statusMessage || a.name,
            email: a.email
          })),
          { placeHolder: "Select account to re-authenticate" }
        );
        if (!pick) return;
        email = pick.email;
      }
      await accountManager.reloginAccount(email);
    }),
    vscode7.commands.registerCommand("antigravitySwap.addAccount", async () => {
      await accountManager.addAccountViaOAuth();
    }),
    vscode7.commands.registerCommand("antigravitySwap.addAccountManual", async () => {
      const email = await vscode7.window.showInputBox({
        title: "Add Account Manually (Step 1/3)",
        prompt: "Enter Google account email address",
        placeHolder: "user@example.com",
        ignoreFocusOut: true
      });
      if (!email) return;
      const accessToken = await vscode7.window.showInputBox({
        title: "Add Account Manually (Step 2/3)",
        prompt: "Enter OAuth Access Token (ya29...)",
        placeHolder: "ya29.a0...",
        password: true,
        ignoreFocusOut: true
      });
      if (!accessToken) return;
      const refreshToken = await vscode7.window.showInputBox({
        title: "Add Account Manually (Step 3/3 - Optional)",
        prompt: "Enter Refresh Token (1//...) for auto-renewal (optional)",
        placeHolder: "1//0g...",
        password: true,
        ignoreFocusOut: true
      });
      const name = await vscode7.window.showInputBox({
        title: "Account Nickname (Optional)",
        prompt: "Enter display name / alias for this account",
        placeHolder: email.split("@")[0],
        ignoreFocusOut: true
      });
      await accountManager.addAccountManually(email, accessToken, refreshToken, name);
    }),
    vscode7.commands.registerCommand("antigravitySwap.removeAccount", async (emailArg) => {
      let email = emailArg;
      if (!email) {
        const accounts = accountManager.getAccounts();
        const pick = await vscode7.window.showQuickPick(
          accounts.map((a) => ({ label: a.email, description: a.name })),
          { placeHolder: "Select account to remove" }
        );
        if (!pick) return;
        email = pick.label;
      }
      await accountManager.removeAccount(email);
    }),
    vscode7.commands.registerCommand("antigravitySwap.refreshQuotas", async () => {
      vscode7.window.withProgress(
        {
          location: vscode7.ProgressLocation.Notification,
          title: "Heartbeat: Refreshing all Antigravity account quotas...",
          cancellable: false
        },
        async () => {
          await heartbeatService.tick();
          vscode7.window.showInformationMessage("\u26A1 Heartbeat quota check completed!");
        }
      );
    }),
    vscode7.commands.registerCommand("antigravitySwap.importExistingAccounts", async () => {
      const count = await accountManager.importDetectedAccounts();
      if (count > 0) {
        vscode7.window.showInformationMessage(`Imported ${count} previously active account(s)!`);
      } else {
        vscode7.window.showInformationMessage("No new accounts detected on local machine.");
      }
    }),
    vscode7.commands.registerCommand("antigravitySwap.importCurrentAntigravity", async () => {
      await accountManager.importCurrentAntigravityAccount();
    }),
    vscode7.commands.registerCommand("antigravitySwap.openDashboard", async () => {
      await vscode7.commands.executeCommand("antigravitySwap.dashboardView.focus");
    })
  );
  console.log("[Antigravity Swap] Extension initialized with Heartbeat.");
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
