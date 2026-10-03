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

// src/constants.ts
var OAUTH_CONFIG = {
  CLIENT_ID: Buffer.from(
    "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
    "base64"
  ).toString("utf-8"),
  CLIENT_SECRET: Buffer.from(
    "R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=",
    "base64"
  ).toString("utf-8"),
  PORTS: [8888, 8889, 8890, 8891, 8892, 45213],
  REDIRECT_PATH: "/oauth-callback",
  SCOPES: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs"
  ]
};
var API_ENDPOINTS = {
  OAUTH_TOKEN_HOST: "oauth2.googleapis.com",
  USER_INFO_HOST: "www.googleapis.com",
  USER_INFO_PATH: "/oauth2/v3/userinfo",
  CLOUD_CODE_HOSTS: [
    "daily-cloudcode-pa.googleapis.com",
    // Primary backend with Claude & GPT rolling quotas
    "cloudcode-pa.googleapis.com"
    // Fallback backend
  ]
};
var STORAGE_KEYS = {
  ACCOUNTS: "antigravitySwap.accounts",
  ACTIVE_ACCOUNT: "antigravitySwap.activeEmail",
  AUTO_SWITCH: "antigravitySwap.autoSwitch"
};
var CONFIG_KEYS = {
  SECTION: "antigravitySwap",
  HEARTBEAT_INTERVAL: "heartbeatIntervalSeconds",
  AUTO_SWITCH_WHEN_LOW: "autoSwitchWhenQuotaLow",
  LOW_QUOTA_THRESHOLD: "lowQuotaThresholdPercent"
};
var EXTENSION_DEFAULTS = {
  DEFAULT_HEARTBEAT_SECONDS: 30,
  DEFAULT_LOW_QUOTA_THRESHOLD_PERCENT: 5,
  ACCOUNT_REFRESH_COOLDOWN_MS: 1e4,
  GLOBAL_REFRESH_COOLDOWN_MS: 1e4
};

// src/storage.ts
var StorageService = class {
  constructor(context, secrets) {
    this.context = context;
    this.secrets = secrets;
  }
  getAccounts() {
    return this.context.globalState.get(STORAGE_KEYS.ACCOUNTS, []);
  }
  async saveAccounts(accounts) {
    await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS, accounts);
  }
  getActiveAccountEmail() {
    return this.context.globalState.get(STORAGE_KEYS.ACTIVE_ACCOUNT);
  }
  async setActiveAccountEmail(email) {
    await this.context.globalState.update(STORAGE_KEYS.ACTIVE_ACCOUNT, email);
  }
  getAutoSwitchEnabled() {
    return this.context.globalState.get(STORAGE_KEYS.AUTO_SWITCH, true);
  }
  async setAutoSwitchEnabled(enabled) {
    await this.context.globalState.update(STORAGE_KEYS.AUTO_SWITCH, enabled);
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
var OAuthService = class {
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
    const { server, port } = await this.bindAvailableServer(OAUTH_CONFIG.PORTS, 0);
    const redirectUri = `http://127.0.0.1:${port}${OAUTH_CONFIG.REDIRECT_PATH}`;
    const state = crypto.randomBytes(16).toString("hex");
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", OAUTH_CONFIG.CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", OAUTH_CONFIG.SCOPES.join(" "));
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
          if (reqUrl.pathname === OAUTH_CONFIG.REDIRECT_PATH) {
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
      client_id: OAUTH_CONFIG.CLIENT_ID,
      client_secret: OAUTH_CONFIG.CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    }).toString();
    const response = await this.httpsPost(API_ENDPOINTS.OAUTH_TOKEN_HOST, "/token", postData, {
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
      client_id: OAUTH_CONFIG.CLIENT_ID,
      client_secret: OAUTH_CONFIG.CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }).toString();
    const response = await this.httpsPost(API_ENDPOINTS.OAUTH_TOKEN_HOST, "/token", postData, {
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
          hostname: API_ENDPOINTS.USER_INFO_HOST,
          port: 443,
          path: API_ENDPOINTS.USER_INFO_PATH,
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
  httpsPost(hostname, path3, body, headers) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname,
          port: 443,
          path: path3,
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
            quotas: account.quotas && account.quotas.length > 0 ? account.quotas : [],
            quotaGroups: account.quotaGroups,
            geminiGroup: account.geminiGroup,
            claudeGptGroup: account.claudeGptGroup,
            averagePercentage: account.averageQuotaPercentage ?? 0,
            hasWeeklyQuota: account.hasWeeklyQuota ?? false,
            has5HourQuota: account.has5HourQuota ?? false,
            accountType: account.accountType || "Google Account",
            tierBadge: account.tierBadge || "STANDARD FREE",
            status: "auth_failed",
            isBanned: false,
            statusMessage: "Refresh token expired or revoked. Please re-login."
          };
        }
      }
    }
    try {
      const quotaData = await this.fetchLiveQuotaData(currentTokens.accessToken);
      console.log(`[QuotaService] Raw response keys for ${account.email}: ${Object.keys(quotaData || {}).join(", ")}`);
      console.log(`[QuotaService] paidTier=${JSON.stringify(quotaData?.paidTier)}, currentTier=${JSON.stringify(quotaData?.currentTier)}, userTier=${JSON.stringify(quotaData?.userTier)}`);
      console.log(`[QuotaService] models keys: ${Object.keys(quotaData?.models || {}).join(", ") || "(none)"}`);
      console.log(`[QuotaService] groups count: ${(quotaData?.groups || quotaData?.response?.groups || []).length}`);
      return this.processQuotaData(quotaData, account);
    } catch (err) {
      const errMsg = err.message || "";
      if (errMsg.includes("USER_SUSPENDED") || errMsg.includes("ACCOUNT_DISABLED") || errMsg.includes("TOS_VIOLATION") || errMsg.includes("Google Account disabled")) {
        return {
          quotas: [],
          averagePercentage: 0,
          hasWeeklyQuota: false,
          has5HourQuota: false,
          accountType: account.accountType || "Standard Free",
          tierBadge: account.tierBadge || "STANDARD FREE",
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
          return this.processQuotaData(quotaData, account);
        } catch (retryErr) {
          const isAuthExpired = retryErr.message?.includes("AUTH_EXPIRED") || retryErr.message?.includes("invalid_grant");
          return {
            quotas: account.quotas && account.quotas.length > 0 ? account.quotas : [],
            quotaGroups: account.quotaGroups,
            geminiGroup: account.geminiGroup,
            claudeGptGroup: account.claudeGptGroup,
            averagePercentage: account.averageQuotaPercentage ?? 0,
            hasWeeklyQuota: account.hasWeeklyQuota ?? false,
            has5HourQuota: account.has5HourQuota ?? false,
            accountType: account.accountType || "Google Account",
            tierBadge: account.tierBadge || "STANDARD FREE",
            status: isAuthExpired ? "auth_failed" : account.status || "active",
            isBanned: false,
            statusMessage: isAuthExpired ? "Credentials expired. Re-login required." : retryErr.message
          };
        }
      }
      return {
        quotas: account.quotas && account.quotas.length > 0 ? account.quotas : [],
        quotaGroups: account.quotaGroups,
        geminiGroup: account.geminiGroup,
        claudeGptGroup: account.claudeGptGroup,
        averagePercentage: account.averageQuotaPercentage ?? 0,
        fiveHourPercentage: account.fiveHourQuotaPercentage,
        weeklyPercentage: account.weeklyQuotaPercentage,
        fiveHourResetTime: account.fiveHourResetTime,
        fiveHourResetCountdown: account.fiveHourResetCountdown,
        weeklyResetTime: account.weeklyResetTime,
        weeklyResetCountdown: account.weeklyResetCountdown,
        has5HourQuota: account.has5HourQuota ?? false,
        hasWeeklyQuota: account.hasWeeklyQuota ?? false,
        accountType: account.accountType || "Google Account",
        tierBadge: account.tierBadge || "STANDARD FREE",
        status: errMsg.includes("401") ? "auth_failed" : account.status || "active",
        isBanned: false,
        statusMessage: errMsg.includes("401") ? "Credentials expired. Re-login required." : "Unable to fetch latest metrics from Google API (temporary)."
      };
    }
  }
  /**
   * Processes raw quota API response into normalized QuotaFetchResult.
   * Keeps Gemini Models and Claude & GPT models in separate QuotaGroups.
   * Keeps 5h rolling window and Weekly plan quota separated without mashing them together.
   */
  processQuotaData(quotaData, account) {
    const hasGroups = (quotaData?.response?.groups || quotaData?.groups || []).length > 0;
    const hasModels = Object.keys(quotaData?.models || {}).length > 0;
    const hasTierData = !!(quotaData?.paidTier || quotaData?.userTier || quotaData?.currentTier || quotaData?.cloudaicompanionProject);
    if (!hasGroups && !hasModels && !hasTierData) {
      console.warn(`[QuotaService] Empty/failed API response for ${account.email}. Preserving existing account state & tier.`);
      return {
        quotas: account.quotas && account.quotas.length > 0 ? account.quotas : [],
        quotaGroups: account.quotaGroups,
        geminiGroup: account.geminiGroup,
        claudeGptGroup: account.claudeGptGroup,
        averagePercentage: account.averageQuotaPercentage ?? 0,
        fiveHourPercentage: account.fiveHourQuotaPercentage,
        weeklyPercentage: account.weeklyQuotaPercentage,
        fiveHourResetTime: account.fiveHourResetTime,
        fiveHourResetCountdown: account.fiveHourResetCountdown,
        weeklyResetTime: account.weeklyResetTime,
        weeklyResetCountdown: account.weeklyResetCountdown,
        has5HourQuota: account.has5HourQuota ?? false,
        hasWeeklyQuota: account.hasWeeklyQuota ?? false,
        accountType: account.accountType || "Google Account",
        tierBadge: account.tierBadge || "STANDARD FREE",
        status: account.status || "active",
        isBanned: account.isBanned || false,
        statusMessage: "Unable to fetch latest metrics from Google API (temporary)."
      };
    }
    const { accountType, tierBadge } = this.determineAccountTier(quotaData, account);
    const isFree = tierBadge === "STANDARD FREE";
    console.log(`[QuotaService] Tier detected: ${tierBadge} (${accountType}) for ${account.email}`);
    const groups = quotaData?.response?.groups || quotaData?.groups || [];
    const quotaGroups = [];
    let parsedQuotas = [];
    let geminiGroup;
    let claudeGptGroup;
    for (const g of groups) {
      const gDisplayName = g.displayName || "";
      const gNameLower = gDisplayName.toLowerCase();
      const isGemini = gNameLower.includes("gemini");
      const isClaudeGpt = gNameLower.includes("claude") || gNameLower.includes("gpt") || gNameLower.includes("3p");
      const groupId = isGemini ? "gemini" : isClaudeGpt ? "claude_gpt" : gDisplayName.toLowerCase().replace(/\s+/g, "_");
      let group5h;
      let groupWeekly;
      const buckets = [];
      for (const b of g.buckets || []) {
        const bWindow = (b.window || "").toLowerCase();
        const bId = (b.bucketId || "").toLowerCase();
        const bNameLower = (b.displayName || "").toLowerCase();
        const is5h = bWindow === "5h" || bId.includes("5h") || bNameLower.includes("5-hour") || bNameLower.includes("five hour");
        const isWeekly = bWindow === "weekly" || bId.includes("weekly") || bNameLower.includes("weekly");
        const windowType = is5h ? "5h" : "weekly";
        const remainingFraction = this.extractFraction(b);
        const percentage = Math.round(remainingFraction * 100);
        const resetTime = b.resetTime || b.quotaInfo?.resetTime || b.quotaResetUTCTimestamp;
        const resetCountdown = resetTime ? this.formatCountdown(resetTime) : void 0;
        const bucket = {
          bucketId: b.bucketId || `${groupId}-${windowType}`,
          displayName: b.displayName || (windowType === "5h" ? "Five Hour Limit Remaining" : "Weekly Limit Remaining"),
          window: windowType,
          remainingFraction,
          percentage,
          resetTime,
          resetCountdown,
          description: b.description,
          disabled: false
        };
        buckets.push(bucket);
        if (is5h && !group5h) group5h = bucket;
        if (isWeekly && !groupWeekly) groupWeekly = bucket;
      }
      const qg = {
        id: groupId,
        name: gDisplayName || (isGemini ? "Gemini Models" : "Claude and GPT models"),
        description: g.description,
        fiveHour: group5h,
        weekly: groupWeekly,
        buckets
      };
      quotaGroups.push(qg);
      if (isGemini) geminiGroup = qg;
      if (isClaudeGpt) claudeGptGroup = qg;
    }
    const rawModels = quotaData?.models || {};
    const seenIds = /* @__PURE__ */ new Set();
    const shouldIgnoreModel = (id, name) => {
      const s = (id + " " + name).toLowerCase();
      return s.startsWith("tab_") || s.startsWith("tab-") || s.startsWith("chat_") || s.startsWith("chat-") || s.includes("autocomplete") || s.includes("preview") || s.includes("thinking effort") || s.includes("thinking_effort") || s.includes("thinking budget") || s.includes("thinking_budget");
    };
    if (Object.keys(rawModels).length > 0) {
      for (const [modelId, modelData] of Object.entries(rawModels)) {
        const displayName = this.formatModelDisplayName(modelId, modelData.displayName);
        if (shouldIgnoreModel(modelId, displayName)) continue;
        const normId = this.normalizeModelKey(modelId);
        if (seenIds.has(normId)) continue;
        seenIds.add(normId);
        const idLower = (modelId + " " + displayName).toLowerCase();
        const isGemini = idLower.includes("gemini") || idLower.includes("flash");
        const isPro = idLower.includes("pro");
        const isClaudeGpt = idLower.includes("claude") || idLower.includes("gpt") || idLower.includes("opus") || idLower.includes("sonnet");
        let targetBucket;
        let windowType = "weekly";
        let windowLabel = "Weekly Quota";
        if (isGemini) {
          if (isPro) {
            targetBucket = geminiGroup?.weekly || geminiGroup?.fiveHour;
            windowType = "weekly";
            windowLabel = "Weekly Quota";
          } else {
            targetBucket = geminiGroup?.fiveHour || geminiGroup?.weekly;
            windowType = geminiGroup?.fiveHour ? "5h" : "weekly";
            windowLabel = geminiGroup?.fiveHour ? "5-Hour Window" : "Weekly Quota";
          }
        } else if (isClaudeGpt) {
          targetBucket = claudeGptGroup?.fiveHour || claudeGptGroup?.weekly || claudeGptGroup?.buckets[0];
          windowType = claudeGptGroup?.fiveHour ? "5h" : "weekly";
          windowLabel = claudeGptGroup?.fiveHour ? "5-Hour Window" : "Weekly Quota";
        }
        const remainingFraction = targetBucket ? targetBucket.remainingFraction : this.extractFraction(modelData);
        const percentage = targetBucket ? targetBucket.percentage : Math.round(remainingFraction * 100);
        const resetTime = targetBucket?.resetTime || modelData.quotaInfo?.resetTime || modelData.resetTime;
        const resetCountdown = targetBucket?.resetCountdown || (resetTime ? this.formatCountdown(resetTime) : void 0);
        parsedQuotas.push({
          id: modelId,
          displayName,
          groupName: isGemini ? "Gemini Models" : isClaudeGpt ? "Claude and GPT models" : targetBucket?.displayName || "Other Models",
          description: targetBucket?.description || modelData.description,
          remainingFraction,
          percentage,
          resetTime,
          resetCountdown,
          windowType,
          windowLabel,
          disabled: targetBucket?.disabled ?? false
        });
      }
    }
    if (parsedQuotas.length === 0 && (geminiGroup || claudeGptGroup)) {
      if (geminiGroup) {
        const g5h = geminiGroup.fiveHour;
        const gWk = geminiGroup.weekly;
        parsedQuotas.push({
          id: "gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          groupName: "Gemini Models",
          description: g5h?.description || "Fast multimodal model for rapid iterations",
          remainingFraction: g5h ? g5h.remainingFraction : gWk ? gWk.remainingFraction : 1,
          percentage: g5h ? g5h.percentage : gWk ? gWk.percentage : 100,
          resetTime: g5h?.resetTime || gWk?.resetTime,
          resetCountdown: g5h?.resetCountdown || gWk?.resetCountdown,
          windowType: g5h ? "5h" : "weekly",
          windowLabel: g5h ? "5-Hour Window" : "Weekly Quota",
          disabled: g5h?.disabled ?? false
        });
        parsedQuotas.push({
          id: "gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          groupName: "Gemini Models",
          description: gWk?.description || "Advanced reasoning and complex coding model",
          remainingFraction: gWk ? gWk.remainingFraction : g5h ? g5h.remainingFraction : 1,
          percentage: gWk ? gWk.percentage : g5h ? g5h.percentage : 100,
          resetTime: gWk?.resetTime || g5h?.resetTime,
          resetCountdown: gWk?.resetCountdown || g5h?.resetCountdown,
          windowType: "weekly",
          windowLabel: "Weekly Quota",
          disabled: gWk?.disabled ?? false
        });
      }
      if (claudeGptGroup) {
        const c5h = claudeGptGroup.fiveHour;
        const cWk = claudeGptGroup.weekly;
        parsedQuotas.push({
          id: "claude-3-7-sonnet",
          displayName: "Claude 3.7 Sonnet",
          groupName: "Claude and GPT models",
          description: c5h?.description || cWk?.description || "Hybrid reasoning and state-of-the-art coding",
          remainingFraction: c5h ? c5h.remainingFraction : cWk ? cWk.remainingFraction : 1,
          percentage: c5h ? c5h.percentage : cWk ? cWk.percentage : 100,
          resetTime: c5h?.resetTime || cWk?.resetTime,
          resetCountdown: c5h?.resetCountdown || cWk?.resetCountdown,
          windowType: c5h ? "5h" : "weekly",
          windowLabel: c5h ? "5-Hour Window" : "Weekly Quota",
          disabled: c5h?.disabled ?? false
        });
        parsedQuotas.push({
          id: "claude-3-5-sonnet",
          displayName: "Claude 3.5 Sonnet",
          groupName: "Claude and GPT models",
          description: cWk?.description || "Intelligent coding and analysis",
          remainingFraction: cWk ? cWk.remainingFraction : 1,
          percentage: cWk ? cWk.percentage : 100,
          resetTime: cWk?.resetTime,
          resetCountdown: cWk?.resetCountdown,
          windowType: "weekly",
          windowLabel: "Weekly Quota",
          disabled: cWk?.disabled ?? false
        });
      }
    }
    parsedQuotas = _QuotaService.sortModelQuotas(parsedQuotas);
    const has5Hour = !!geminiGroup?.fiveHour || !!claudeGptGroup?.fiveHour;
    const hasWeekly = !!geminiGroup?.weekly || !!claudeGptGroup?.weekly;
    const fiveHourResetTime = geminiGroup?.fiveHour?.resetTime;
    const fiveHourResetCountdown = geminiGroup?.fiveHour?.resetCountdown;
    const fiveHourPercentage = geminiGroup?.fiveHour ? geminiGroup.fiveHour.percentage : void 0;
    const weeklyResetTime = geminiGroup?.weekly?.resetTime;
    const weeklyResetCountdown = geminiGroup?.weekly?.resetCountdown;
    const weeklyPercentage = geminiGroup?.weekly ? geminiGroup.weekly.percentage : void 0;
    const geminiAvailable = (geminiGroup?.weekly?.percentage ?? 0) > 0 && (!geminiGroup?.fiveHour || geminiGroup.fiveHour.percentage > 0);
    const claudeAvailable = (claudeGptGroup?.weekly?.percentage ?? 0) > 0 && (!claudeGptGroup?.fiveHour || claudeGptGroup.fiveHour.percentage > 0);
    let status = "active";
    let statusMessage;
    if (!geminiAvailable && !claudeAvailable) {
      status = "low_balance";
      statusMessage = "All model quotas depleted";
    } else if (!geminiAvailable && claudeAvailable) {
      statusMessage = "Gemini depleted \xB7 Claude available";
    } else if (geminiAvailable && !claudeAvailable) {
      statusMessage = "Claude depleted \xB7 Gemini available";
    }
    const geminiActivePct = geminiGroup?.fiveHour && !geminiGroup.fiveHour.disabled && geminiGroup.fiveHour.percentage >= 0 ? geminiGroup.fiveHour.percentage : geminiGroup?.weekly && !geminiGroup.weekly.disabled && geminiGroup.weekly.percentage >= 0 ? geminiGroup.weekly.percentage : void 0;
    const claudeActivePct = claudeGptGroup?.fiveHour && !claudeGptGroup.fiveHour.disabled && claudeGptGroup.fiveHour.percentage >= 0 ? claudeGptGroup.fiveHour.percentage : claudeGptGroup?.weekly && !claudeGptGroup.weekly.disabled && claudeGptGroup.weekly.percentage >= 0 ? claudeGptGroup.weekly.percentage : void 0;
    let averagePercentage = 0;
    if (geminiActivePct !== void 0 && claudeActivePct !== void 0) {
      averagePercentage = Math.round((geminiActivePct + claudeActivePct) / 2);
    } else if (geminiActivePct !== void 0) {
      averagePercentage = geminiActivePct;
    } else if (claudeActivePct !== void 0) {
      averagePercentage = claudeActivePct;
    } else {
      averagePercentage = this.calculateAveragePercentage(parsedQuotas);
    }
    return {
      quotas: parsedQuotas,
      quotaGroups,
      geminiGroup,
      claudeGptGroup,
      averagePercentage,
      fiveHourPercentage,
      weeklyPercentage,
      fiveHourResetTime,
      fiveHourResetCountdown,
      weeklyResetTime,
      weeklyResetCountdown,
      has5HourQuota: has5Hour,
      hasWeeklyQuota: hasWeekly,
      accountType,
      tierBadge,
      status,
      isBanned: false,
      statusMessage
    };
  }
  /**
   * Finds the soonest upcoming reset time from a list of model quotas.
   */
  findSoonestResetTime(quotas) {
    const valid = quotas.filter((q) => !!q.resetTime);
    if (valid.length === 0) return void 0;
    const now = Date.now();
    const future = valid.map((q) => ({ time: q.resetTime, ms: new Date(q.resetTime).getTime() })).filter((item) => !isNaN(item.ms) && item.ms > now).sort((a, b) => a.ms - b.ms);
    if (future.length > 0) {
      return future[0].time;
    }
    return valid[0].resetTime;
  }
  /**
   * Multi-strategy live quota fetching against Cloud Code PA backend.
   * Uses daily-cloudcode-pa.googleapis.com first (primary Antigravity backend with Claude & GPT)
   * with fallback to cloudcode-pa.googleapis.com.
   */
  async fetchLiveQuotaData(accessToken) {
    let projectId;
    let tierData = {};
    let lastAuthError = null;
    let anyEndpointSucceeded = false;
    const hosts = API_ENDPOINTS.CLOUD_CODE_HOSTS;
    const codeAssistBodies = [
      {
        metadata: {
          ide_type: "ANTIGRAVITY",
          ide_version: "1.22.2",
          ide_name: "antigravity"
        }
      },
      {
        metadata: {
          ideType: "ANTIGRAVITY",
          ideVersion: "1.22.2",
          ideName: "antigravity",
          platform: "WINDOWS",
          pluginType: "GEMINI"
        }
      },
      {
        metadata: { ideType: "ANTIGRAVITY" }
      },
      {}
    ];
    for (const host of hosts) {
      for (const body2 of codeAssistBodies) {
        try {
          const res = await this.callCloudCodePost(accessToken, host, "/v1internal:loadCodeAssist", body2);
          if (res) {
            anyEndpointSucceeded = true;
            if (res.cloudaicompanionProject) {
              projectId = res.cloudaicompanionProject;
            }
            tierData = { ...tierData, ...res };
            break;
          }
        } catch (err) {
          if (err.message && (err.message.includes("401") || err.message.includes("UNAUTHENTICATED"))) {
            lastAuthError = err;
          }
        }
      }
      if (projectId || Object.keys(tierData).length > 0) break;
    }
    const body = projectId ? { project: projectId } : {};
    let groupsData = null;
    let modelsData = null;
    for (const host of hosts) {
      if (!groupsData) {
        try {
          groupsData = await this.callCloudCodePost(accessToken, host, "/v1internal:retrieveUserQuotaSummary", body);
          if (groupsData) anyEndpointSucceeded = true;
        } catch (err) {
          if (err.message && (err.message.includes("401") || err.message.includes("UNAUTHENTICATED"))) {
            lastAuthError = err;
          }
          if (projectId) {
            try {
              groupsData = await this.callCloudCodePost(accessToken, host, "/v1internal:retrieveUserQuotaSummary", {});
              if (groupsData) anyEndpointSucceeded = true;
            } catch {
            }
          }
        }
      }
      if (!modelsData) {
        try {
          modelsData = await this.callCloudCodePost(accessToken, host, "/v1internal:fetchAvailableModels", body);
          if (modelsData) anyEndpointSucceeded = true;
        } catch (err) {
          if (err.message && (err.message.includes("401") || err.message.includes("UNAUTHENTICATED"))) {
            lastAuthError = err;
          }
          if (projectId) {
            try {
              modelsData = await this.callCloudCodePost(accessToken, host, "/v1internal:fetchAvailableModels", {});
              if (modelsData) anyEndpointSucceeded = true;
            } catch {
            }
          }
        }
      }
      if (groupsData && modelsData) break;
    }
    if (!anyEndpointSucceeded && lastAuthError) {
      throw lastAuthError;
    }
    return {
      ...tierData,
      ...groupsData || {},
      models: modelsData?.models || groupsData?.models || tierData?.models || {},
      response: groupsData?.response || groupsData
    };
  }
  callCloudCodePost(accessToken, hostname, path3, body = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = https2.request(
        {
          hostname,
          port: 443,
          path: path3,
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
  extractFraction(data) {
    if (!data) return 0;
    const q = data.quotaInfo || data.quota || data.userQuota || data;
    if (!q) return 0;
    if (typeof q.remainingFraction === "number") return Math.max(0, Math.min(1, q.remainingFraction));
    if (typeof data.remainingFraction === "number") return Math.max(0, Math.min(1, data.remainingFraction));
    if (typeof q.fraction === "number") return Math.max(0, Math.min(1, q.fraction));
    if (typeof data.fraction === "number") return Math.max(0, Math.min(1, data.fraction));
    if (typeof q.remainingQuota === "number") return Math.max(0, Math.min(1, q.remainingQuota));
    if (q.remaining && typeof q.remaining === "object") {
      if (typeof q.remaining.value === "number") return Math.max(0, Math.min(1, q.remaining.value));
      if (typeof q.remaining.remainingFraction === "number") return Math.max(0, Math.min(1, q.remaining.remainingFraction));
      if (typeof q.remaining.fraction === "number") return Math.max(0, Math.min(1, q.remaining.fraction));
    }
    if (data.remaining && typeof data.remaining === "object") {
      if (typeof data.remaining.value === "number") return Math.max(0, Math.min(1, data.remaining.value));
      if (typeof data.remaining.remainingFraction === "number") return Math.max(0, Math.min(1, data.remaining.remainingFraction));
      if (typeof data.remaining.fraction === "number") return Math.max(0, Math.min(1, data.remaining.fraction));
    }
    if (typeof q.remaining === "number") return Math.max(0, Math.min(1, q.remaining));
    if (typeof q.remainingPercentage === "number") return Math.max(0, Math.min(1, q.remainingPercentage / 100));
    if (typeof q.percentage === "number") return Math.max(0, Math.min(1, q.percentage / 100));
    if (typeof q.usedFraction === "number") return Math.max(0, Math.min(1, 1 - q.usedFraction));
    if (typeof q.consumedFraction === "number") return Math.max(0, Math.min(1, 1 - q.consumedFraction));
    if (typeof data.usedFraction === "number") return Math.max(0, Math.min(1, 1 - data.usedFraction));
    if (data.quotaInfo || q.resetTime || data.resetTime) {
      return 0;
    }
    return 0;
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
    const groups = rawResponse?.response?.groups || rawResponse?.groups || [];
    if (groups.length > 0) {
      for (const group of groups) {
        const groupName = (group.displayName || "").toLowerCase();
        const buckets = group.buckets || [];
        const bucket5h = buckets.find(
          (b) => b.window && b.window.toLowerCase() === "5h" || b.bucketId && b.bucketId.toLowerCase().includes("5h") || b.displayName && (b.displayName.toLowerCase().includes("5-hour") || b.displayName.toLowerCase().includes("five hour"))
        );
        const bucketWeekly = buckets.find(
          (b) => b.window && b.window.toLowerCase() === "weekly" || b.bucketId && b.bucketId.toLowerCase().includes("weekly") || b.displayName && b.displayName.toLowerCase().includes("weekly")
        );
        if (groupName.includes("gemini")) {
          const has5h = !!bucket5h;
          const flashBucket = bucket5h || bucketWeekly || buckets[0] || {};
          const flashFraction = this.extractFraction(flashBucket);
          const flashPct = Math.round(flashFraction * 100);
          const flashResetTime = flashBucket.quotaInfo?.resetTime || flashBucket.resetTime || flashBucket.quotaResetUTCTimestamp;
          const flashCountdown = flashResetTime ? this.formatCountdown(flashResetTime) : void 0;
          const proBucket = bucketWeekly || bucket5h || buckets[0] || {};
          const proFraction = this.extractFraction(proBucket);
          const proPct = Math.round(proFraction * 100);
          const proResetTime = proBucket.quotaInfo?.resetTime || proBucket.resetTime || proBucket.quotaResetUTCTimestamp;
          const proCountdown = proResetTime ? this.formatCountdown(proResetTime) : void 0;
          const geminiFlashModels = [
            { id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash" },
            { id: "gemini-3.7-flash", displayName: "Gemini 3.7 Flash" },
            { id: "gemini-3.6-flash", displayName: "Gemini 3.6 Flash" },
            { id: "gemini-3.1-flash", displayName: "Gemini 3.1 Flash" }
          ];
          for (const m of geminiFlashModels) {
            if (seenIds.has(m.id)) continue;
            seenIds.add(m.id);
            list.push({
              id: m.id,
              displayName: m.displayName,
              description: flashBucket.description || group.description,
              remainingFraction: flashFraction,
              percentage: flashPct,
              resetTime: flashResetTime,
              resetCountdown: flashCountdown,
              windowType: has5h ? "5h" : "weekly",
              windowLabel: has5h ? "5-Hour Rolling Window" : "Weekly Plan Quota",
              disabled: flashBucket.disabled ?? false
            });
          }
          const geminiProModels = [
            { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
            { id: "gemini-3.1-pro", displayName: "Gemini 3.1 Pro" }
          ];
          for (const m of geminiProModels) {
            if (seenIds.has(m.id)) continue;
            seenIds.add(m.id);
            list.push({
              id: m.id,
              displayName: m.displayName,
              description: proBucket.description || group.description,
              remainingFraction: proFraction,
              percentage: proPct,
              resetTime: proResetTime,
              resetCountdown: proCountdown,
              windowType: "weekly",
              windowLabel: "Weekly Plan Quota",
              disabled: proBucket.disabled ?? false
            });
          }
        } else if (groupName.includes("claude") || groupName.includes("gpt") || groupName.includes("3p")) {
          const thirdPartyBucket = bucketWeekly || bucket5h || buckets[0] || {};
          const fraction = this.extractFraction(thirdPartyBucket);
          const percentage = Math.round(fraction * 100);
          const resetTime = thirdPartyBucket.quotaInfo?.resetTime || thirdPartyBucket.resetTime || thirdPartyBucket.quotaResetUTCTimestamp;
          const resetCountdown = resetTime ? this.formatCountdown(resetTime) : void 0;
          const thirdPartyModels = [
            { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
            { id: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
            { id: "gpt-oss-120b", displayName: "GPT-OSS 120B" }
          ];
          for (const m of thirdPartyModels) {
            if (seenIds.has(m.id)) continue;
            seenIds.add(m.id);
            list.push({
              id: m.id,
              displayName: m.displayName,
              description: thirdPartyBucket.description || group.description,
              remainingFraction: fraction,
              percentage,
              resetTime,
              resetCountdown,
              windowType: "weekly",
              windowLabel: "Weekly Plan Quota",
              disabled: thirdPartyBucket.disabled ?? false
            });
          }
        }
      }
    }
    if (rawResponse && rawResponse.models) {
      for (const [modelId, modelData] of Object.entries(rawResponse.models)) {
        const displayName = this.formatModelDisplayName(modelId, modelData.displayName);
        if (shouldIgnoreModel(modelId, displayName)) {
          continue;
        }
        const normId = this.normalizeModelKey(modelId);
        if (seenIds.has(normId)) continue;
        seenIds.add(normId);
        const fraction = this.extractFraction(modelData);
        const percentage = Math.round(fraction * 100);
        const resetTime = modelData.quotaInfo?.resetTime || modelData.resetTime;
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
    const extractVersion = (s) => {
      const match = s.match(/(\d+(?:\.\d+)?)/);
      return match ? parseFloat(match[1]) : 0;
    };
    const getRank = (q) => {
      const s = (q.id + " " + (q.displayName || "")).toLowerCase();
      const isGemini = s.includes("gemini") || s.includes("flash");
      const isClaude = s.includes("claude") || s.includes("opus") || s.includes("sonnet") || s.includes("haiku");
      const isGpt = s.includes("gpt");
      const ver = extractVersion(s);
      if (isGemini) {
        const typeBonus = s.includes("pro") ? 0.05 : 0;
        return 1e3 - (ver * 100 + typeBonus);
      }
      if (isClaude) {
        const typeBonus = s.includes("opus") ? 0.1 : s.includes("sonnet") ? 0.05 : 0;
        return 2e3 - (ver * 100 + typeBonus);
      }
      if (isGpt) {
        return 3e3 - ver;
      }
      return 4e3;
    };
    return [...quotas].sort((a, b) => {
      const rankA = getRank(a);
      const rankB = getRank(b);
      if (rankA !== rankB) return rankA - rankB;
      return (a.displayName || a.id).localeCompare(b.displayName || b.id);
    });
  }
  /**
   * Classifies a model quota into 5h rolling window vs weekly plan quota.
   */
  classifyQuotaWindow(id, displayName, resetTime, description) {
    const idLower = (id + " " + displayName + " " + (description || "")).toLowerCase();
    if (idLower.includes("claude") || idLower.includes("opus") || idLower.includes("sonnet") || idLower.includes("gpt-oss") || idLower.includes("gpt_oss") || idLower.includes("gpt") || idLower.includes("gemini-2.5-pro") || idLower.includes("gemini-3-pro") || idLower.includes("gemini-pro") || idLower.includes("weekly") || idLower.includes("plan quota") || idLower.includes("pro-agent")) {
      return { windowType: "weekly", windowLabel: "Weekly Plan Quota" };
    }
    if (idLower.includes("flash") || idLower.includes("5h")) {
      return { windowType: "5h", windowLabel: "5-Hour Rolling Window" };
    }
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
    return { windowType: "5h", windowLabel: "5-Hour Rolling Window" };
  }
  /**
   * Determines account subscription tier strictly based on Google account subscription data.
   * Standard free accounts will always receive 'STANDARD FREE' without Pro badge.
   */
  determineAccountTier(rawResponse, account) {
    if (!rawResponse) {
      return {
        accountType: account?.accountType || "Standard Free",
        tierBadge: account?.tierBadge || "STANDARD FREE"
      };
    }
    const checkStringForPaidTier = (val) => {
      if (!val || typeof val !== "string") return null;
      const s = val.toLowerCase();
      if (s.includes("enterprise") || s.includes("corporate") || s.includes("workspace_enterprise")) return "ENTERPRISE";
      if (s.includes("ultra") || s.includes("gemini_ultra") || s.includes("ai_ultra") || s.includes("g1-ultra")) return "ULTRA";
      if (s.includes("ai_premium") || s.includes("ai premium") || s.includes("gemini advanced") || s.includes("google_one_premium") || s.includes("g1-premium")) return "AI PREMIUM";
      if (s.includes("user_tier_pro") || s.includes("tier_pro") || s.includes("google_one_pro") || s.includes("pro_tier") || s.includes("g1-pro") || s.includes("google ai pro") || /\bpro\b/.test(s)) {
        return "PRO";
      }
      return null;
    };
    if (rawResponse.paidTier) {
      if (typeof rawResponse.paidTier === "object") {
        const id = (rawResponse.paidTier.id || "").toLowerCase();
        const name = (rawResponse.paidTier.name || "").toLowerCase();
        const desc = (rawResponse.paidTier.description || "").toLowerCase();
        const combined = `${id} ${name} ${desc}`;
        const t = checkStringForPaidTier(combined);
        if (t) return this.mapBadgeToResult(t);
        if (id === "free-tier" || name.includes("starter") || combined.includes("free-tier")) {
          if (!rawResponse.userTier || !checkStringForPaidTier(typeof rawResponse.userTier === "string" ? rawResponse.userTier : JSON.stringify(rawResponse.userTier))) {
            return { accountType: "Standard Free", tierBadge: "STANDARD FREE" };
          }
        }
      } else if (typeof rawResponse.paidTier === "string") {
        const t = checkStringForPaidTier(rawResponse.paidTier);
        if (t) return this.mapBadgeToResult(t);
        if (rawResponse.paidTier.toLowerCase().includes("free")) {
          return { accountType: "Standard Free", tierBadge: "STANDARD FREE" };
        }
      }
    }
    if (rawResponse.userTier) {
      if (typeof rawResponse.userTier === "object") {
        const combined = `${rawResponse.userTier.id || ""} ${rawResponse.userTier.name || ""} ${rawResponse.userTier.description || ""}`;
        const t = checkStringForPaidTier(combined);
        if (t) return this.mapBadgeToResult(t);
      } else if (typeof rawResponse.userTier === "string") {
        const t = checkStringForPaidTier(rawResponse.userTier);
        if (t) return this.mapBadgeToResult(t);
      }
    }
    const planObj = rawResponse.plan || rawResponse.subscription || rawResponse.userSubscription || rawResponse.accountPlan;
    if (planObj) {
      const s = typeof planObj === "string" ? planObj : JSON.stringify(planObj);
      const t = checkStringForPaidTier(s);
      if (t) return this.mapBadgeToResult(t);
    }
    const groups = rawResponse?.response?.groups || rawResponse?.groups || [];
    const has5hBucket = groups.some(
      (g) => (g.buckets || []).some((b) => {
        const win = (b.window || "").toLowerCase();
        const bId = (b.bucketId || "").toLowerCase();
        const dName = (b.displayName || "").toLowerCase();
        return win === "5h" || bId.includes("5h") || dName.includes("5-hour") || dName.includes("five hour");
      })
    );
    if (has5hBucket) {
      return { accountType: "Google AI Pro", tierBadge: "PRO" };
    }
    if (rawResponse.currentTier) {
      if (typeof rawResponse.currentTier === "object") {
        const id = (rawResponse.currentTier.id || "").toLowerCase();
        const name = (rawResponse.currentTier.name || "").toLowerCase();
        if (id !== "free-tier" && !id.includes("free")) {
          const t = checkStringForPaidTier(`${id} ${name}`);
          if (t) return this.mapBadgeToResult(t);
        }
      } else if (typeof rawResponse.currentTier === "string") {
        if (!rawResponse.currentTier.toLowerCase().includes("free")) {
          const t = checkStringForPaidTier(rawResponse.currentTier);
          if (t) return this.mapBadgeToResult(t);
        }
      }
    }
    if (account?.tierBadge && account.tierBadge !== "STANDARD FREE") {
      return {
        accountType: account.accountType || this.mapBadgeToResult(account.tierBadge).accountType,
        tierBadge: account.tierBadge
      };
    }
    return { accountType: "Standard Free", tierBadge: "STANDARD FREE" };
  }
  mapBadgeToResult(tier) {
    switch (tier) {
      case "ENTERPRISE":
        return { accountType: "Antigravity Enterprise", tierBadge: "ENTERPRISE" };
      case "ULTRA":
        return { accountType: "Google AI Ultra", tierBadge: "ULTRA" };
      case "AI PREMIUM":
        return { accountType: "Google AI Premium", tierBadge: "AI PREMIUM" };
      case "PRO":
        return { accountType: "Google AI Pro", tierBadge: "PRO" };
      case "STANDARD FREE":
      default:
        return { accountType: "Standard Free", tierBadge: "STANDARD FREE" };
    }
  }
  /**
   * Computes capacity-weighted overall aggregate percentage across all healthy accounts.
   * Accounts with higher tier allocations (Enterprise > Ultra > AI Premium > Pro > Free) contribute proportionately:
   * - Enterprise: 5.0x weight
   * - Ultra: 4.0x weight
   * - AI Premium: 3.0x weight
   * - Pro: 1.0x weight
   * - Free: 0.5x baseline weight (at 100% standard access) for overall; 0x weight for weekly & 5h windows.
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
    const getTierWeights = (tier) => {
      switch (tier) {
        case "ENTERPRISE":
          return { overall: 5, fiveHour: 5, weekly: 5 };
        case "ULTRA":
          return { overall: 4, fiveHour: 4, weekly: 4 };
        case "AI PREMIUM":
          return { overall: 3, fiveHour: 3, weekly: 3 };
        case "PRO":
          return { overall: 1, fiveHour: 1, weekly: 1 };
        case "STANDARD FREE":
        default:
          return { overall: 0.5, fiveHour: 0.5, weekly: 0.5 };
      }
    };
    const activeAcc = accounts.find((a) => a.isActive) || accounts[0];
    let sumOverallWeighted = 0;
    let totalOverallWeight = 0;
    let sum5hWeighted = 0;
    let total5hWeight = 0;
    let sumWeeklyWeighted = 0;
    let totalWeeklyWeight = 0;
    let sumGemini5h = 0, totalGemini5hWeight = 0;
    let sumGeminiWeekly = 0, totalGeminiWeeklyWeight = 0;
    let sumClaude5h = 0, totalClaude5hWeight = 0;
    let sumClaudeWeekly = 0, totalClaudeWeeklyWeight = 0;
    let maxPercentage = 0;
    let healthyCount = 0;
    let lowCount = 0;
    let errorCount = 0;
    let proCount = 0;
    for (const acc of accounts) {
      const isFree = !acc.tierBadge || acc.tierBadge === "STANDARD FREE";
      if (!isFree) {
        proCount++;
      }
      if (acc.isBanned || acc.status === "auth_failed" || acc.status === "banned") {
        errorCount++;
        continue;
      }
      healthyCount++;
      const p = acc.averageQuotaPercentage ?? 0;
      if (p > maxPercentage) maxPercentage = p;
      if (p < 20) {
        lowCount++;
      }
      const weights = getTierWeights(acc.tierBadge);
      const accWeight = weights.overall;
      sumOverallWeighted += p * accWeight;
      totalOverallWeight += accWeight;
      const has5h = acc.fiveHourQuotaPercentage !== void 0 || acc.geminiGroup?.fiveHour && !acc.geminiGroup.fiveHour.disabled;
      if (has5h) {
        const val5h = acc.fiveHourQuotaPercentage ?? acc.geminiGroup?.fiveHour?.percentage ?? acc.claudeGptGroup?.fiveHour?.percentage ?? 0;
        sum5hWeighted += val5h * weights.fiveHour;
        total5hWeight += weights.fiveHour;
      }
      const hasWk = acc.weeklyQuotaPercentage !== void 0 || acc.geminiGroup?.weekly && !acc.geminiGroup.weekly.disabled;
      if (hasWk) {
        const valWk = acc.weeklyQuotaPercentage ?? acc.geminiGroup?.weekly?.percentage ?? acc.claudeGptGroup?.weekly?.percentage ?? 0;
        sumWeeklyWeighted += valWk * weights.weekly;
        totalWeeklyWeight += weights.weekly;
      }
      const g5h = acc.geminiGroup?.fiveHour;
      if (g5h && !g5h.disabled && g5h.percentage >= 0) {
        sumGemini5h += g5h.percentage * weights.fiveHour;
        totalGemini5hWeight += weights.fiveHour;
      }
      const gWk = acc.geminiGroup?.weekly;
      if (gWk && !gWk.disabled && gWk.percentage >= 0) {
        sumGeminiWeekly += gWk.percentage * weights.weekly;
        totalGeminiWeeklyWeight += weights.weekly;
      }
      const c5h = acc.claudeGptGroup?.fiveHour;
      if (c5h && !c5h.disabled && c5h.percentage >= 0) {
        sumClaude5h += c5h.percentage * weights.fiveHour;
        totalClaude5hWeight += weights.fiveHour;
      }
      const cWk = acc.claudeGptGroup?.weekly;
      if (cWk && !cWk.disabled && cWk.percentage >= 0) {
        sumClaudeWeekly += cWk.percentage * weights.weekly;
        totalClaudeWeeklyWeight += weights.weekly;
      }
    }
    const overallPct = totalOverallWeight > 0 ? Math.round(sumOverallWeighted / totalOverallWeight) : 0;
    const overall5hPct = total5hWeight > 0 ? Math.round(sum5hWeighted / total5hWeight) : void 0;
    const overallWeeklyPct = totalWeeklyWeight > 0 ? Math.round(sumWeeklyWeighted / totalWeeklyWeight) : void 0;
    const gemini5hPct = totalGemini5hWeight > 0 ? Math.round(sumGemini5h / totalGemini5hWeight) : void 0;
    const geminiWkPct = totalGeminiWeeklyWeight > 0 ? Math.round(sumGeminiWeekly / totalGeminiWeeklyWeight) : void 0;
    const claude5hPct = totalClaude5hWeight > 0 ? Math.round(sumClaude5h / totalClaude5hWeight) : void 0;
    const claudeWkPct = totalClaudeWeeklyWeight > 0 ? Math.round(sumClaudeWeekly / totalClaudeWeeklyWeight) : void 0;
    const activePct = activeAcc ? activeAcc.averageQuotaPercentage || 0 : 0;
    return {
      totalAccounts: accounts.length,
      activeAccountEmail: activeAcc?.email,
      overallPercentage: errorCount === accounts.length ? 0 : overallPct,
      gemini5HourPercentage: gemini5hPct,
      geminiWeeklyPercentage: geminiWkPct,
      claude5HourPercentage: claude5hPct,
      claudeWeeklyPercentage: claudeWkPct,
      overall5HourPercentage: overall5hPct ?? 0,
      overallWeeklyPercentage: overallWeeklyPct ?? 0,
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
    vscode3.window.onDidChangeWindowState((e) => {
      if (e.focused) {
        this.syncCurrentAccountFromIde().catch(() => {
        });
      }
    });
    await this.syncCurrentAccountFromIde();
    if (this.accounts.length === 0) {
      await this.importDetectedAccounts();
    }
    await this.refreshAllQuotas().catch((err) => console.warn("[Antigravity Swap] Initial quota refresh failed:", err));
    if (this.isAutoSwitchEnabled()) {
      await this.checkAutoSwitch();
    }
  }
  /**
   * Syncs active account status from the IDE's internal state.vscdb
   */
  async syncCurrentAccountFromIde() {
    const currentSession = await this.storage.getCurrentAntigravityAccount().catch(() => null);
    const ideEmail = currentSession?.email;
    if (!ideEmail) {
      if (this.activeEmail !== void 0) {
        this.activeEmail = void 0;
        this.accounts = this.accounts.map((a) => ({ ...a, isActive: false }));
        await this.storage.saveAccounts(this.accounts);
        await this.storage.setActiveAccountEmail(void 0);
        this._onDidChangeState.fire();
      }
      return;
    }
    const existingAcc = this.accounts.find((a) => a.email === ideEmail);
    if (!existingAcc) {
      if (this.activeEmail !== void 0 || this.accounts.some((a) => a.isActive)) {
        console.log(`[Antigravity Swap] Current IDE account (${ideEmail}) is not in extension list. Deactivating extension accounts.`);
        this.activeEmail = void 0;
        this.accounts = this.accounts.map((a) => ({ ...a, isActive: false }));
        await this.storage.saveAccounts(this.accounts);
        await this.storage.setActiveAccountEmail(void 0);
        this._onDidChangeState.fire();
      }
      return;
    }
    let changed = false;
    if (currentSession.accessToken) {
      const existingTokens = await this.storage.getAccountTokens(ideEmail);
      const tokens = {
        accessToken: currentSession.accessToken,
        refreshToken: currentSession.refreshToken || existingTokens?.refreshToken,
        expiresAt: Date.now() + 3600 * 1e3
      };
      await this.storage.saveAccountTokens(ideEmail, tokens);
    }
    if (currentSession.name && existingAcc.name !== currentSession.name) {
      existingAcc.name = currentSession.name;
      changed = true;
    }
    if (currentSession.avatarUrl && existingAcc.avatarUrl !== currentSession.avatarUrl) {
      existingAcc.avatarUrl = currentSession.avatarUrl;
      changed = true;
    }
    if (this.activeEmail !== ideEmail || !existingAcc.isActive) {
      this.activeEmail = ideEmail;
      this.accounts = this.accounts.map((a) => ({
        ...a,
        isActive: a.email === ideEmail,
        lastUsedAt: a.email === ideEmail ? (/* @__PURE__ */ new Date()).toISOString() : a.lastUsedAt
      }));
      changed = true;
    }
    if (changed) {
      await this.storage.saveAccounts(this.accounts);
      await this.storage.setActiveAccountEmail(ideEmail);
      this._onDidChangeState.fire();
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
    await this.storage.syncToIdeStateDb(target, tokens);
    await this.storage.syncToCloudAccountsDb(email);
    try {
      await vscode3.commands.executeCommand("antigravity.restartLanguageServer");
      console.log("[Antigravity Swap] Executed antigravity.restartLanguageServer successfully");
    } catch (lsErr) {
      console.warn("[Antigravity Swap] restartLanguageServer command warning:", lsErr?.message || lsErr);
    }
    this._onDidChangeState.fire();
    this.refreshAccountQuota(email).catch(() => {
    });
    vscode3.window.showInformationMessage(`Switched to: ${target.name || email}!`);
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
    const existingTokens = await this.storage.getAccountTokens(current.email);
    const tokens = {
      accessToken: current.accessToken,
      refreshToken: current.refreshToken || existingTokens?.refreshToken,
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
   * Removes multiple accounts simultaneously.
   */
  async removeMultipleAccounts(emails) {
    if (!emails || emails.length === 0) return;
    const emailSet = new Set(emails);
    const wasActiveRemoved = this.activeEmail && emailSet.has(this.activeEmail);
    this.accounts = this.accounts.filter((a) => !emailSet.has(a.email));
    await this.storage.saveAccounts(this.accounts);
    for (const email of emails) {
      await this.storage.removeAccountTokens(email);
    }
    if (wasActiveRemoved && this.accounts.length > 0) {
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
    vscode3.window.showInformationMessage(`Removed ${emails.length} account(s).`);
    this._onDidChangeState.fire();
  }
  /**
   * Refreshes quota balances for multiple selected accounts.
   */
  async refreshMultipleAccounts(emails) {
    if (!emails || emails.length === 0) return;
    for (const email of emails) {
      await this.refreshAccountQuota(email);
    }
    await this.checkAutoSwitch();
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
    acc.quotaGroups = res.quotaGroups;
    acc.geminiGroup = res.geminiGroup;
    acc.claudeGptGroup = res.claudeGptGroup;
    acc.averageQuotaPercentage = res.averagePercentage;
    acc.fiveHourQuotaPercentage = res.fiveHourPercentage;
    acc.weeklyQuotaPercentage = res.weeklyPercentage;
    acc.fiveHourResetTime = res.fiveHourResetTime;
    acc.fiveHourResetCountdown = res.fiveHourResetCountdown;
    acc.weeklyResetTime = res.weeklyResetTime;
    acc.weeklyResetCountdown = res.weeklyResetCountdown;
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
    await this.syncCurrentAccountFromIde();
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
    const config = vscode3.workspace.getConfiguration(CONFIG_KEYS.SECTION);
    const threshold = config.get(CONFIG_KEYS.LOW_QUOTA_THRESHOLD, EXTENSION_DEFAULTS.DEFAULT_LOW_QUOTA_THRESHOLD_PERCENT);
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
    const md = new vscode4.MarkdownString("", true);
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.appendMarkdown(`### $(zap) Antigravity Swap

`);
    const accountHealthIcon = active.isBanned ? "$(error)" : activePct < 20 ? "$(warning)" : "$(check)";
    md.appendMarkdown(`**Active:** ${active.name || active.email}

`);
    md.appendMarkdown(`${accountHealthIcon} \`${active.email}\` \u2014 **${activePct}%** remaining

`);
    const allAccIcon = overallPct < 20 ? "$(warning)" : "$(account)";
    md.appendMarkdown(`${allAccIcon} **All ${overall.totalAccounts} account(s):** ${overallPct}% avg

`);
    const quotas = active.quotas ?? [];
    if (quotas.length > 0) {
      md.appendMarkdown(`---

`);
      md.appendMarkdown(`**$(pulse) Model Quotas**

`);
      for (const q of quotas) {
        const isUnlimited = q.percentage === -1;
        const pct = isUnlimited ? 100 : Math.max(0, Math.min(100, q.percentage || 0));
        const healthIcon = isUnlimited ? "$(infinity)" : pct > 50 ? "$(check)" : pct > 20 ? "$(warning)" : "$(error)";
        const pctLabel = isUnlimited ? "Unlimited" : `${pct}%`;
        const resetInfo = q.resetCountdown ? ` \xB7 resets ${q.resetCountdown}` : "";
        md.appendMarkdown(`${healthIcon} **${q.displayName}** \u2014 ${pctLabel}${resetInfo}

`);
      }
    } else if (!active.isBanned) {
      md.appendMarkdown(`---

`);
      md.appendMarkdown(`$(info) No quota data yet. Open the panel and click **Refresh Quotas**.

`);
    }
    md.appendMarkdown(`---

`);
    md.appendMarkdown(`*$(list-unordered) Click to open the account switcher*`);
    this.statusBarItem.tooltip = md;
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
var fs2 = __toESM(require("fs"));
var path2 = __toESM(require("path"));
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
  _panel;
  resolveWebviewView(webviewView, _context, _token) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = this.getHtmlContent(webviewView.webview);
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.accountManager.syncCurrentAccountFromIde().catch(() => {
        });
        this.updateWebview();
      }
    });
    this.accountManager.syncCurrentAccountFromIde().then(() => this.updateWebview());
    webviewView.webview.onDidReceiveMessage((data) => this.handleWebviewMessage(data));
    this.updateWebview();
  }
  /**
   * Opens or reveals the Dashboard and automatically detaches it into a real native OS window.
   */
  async openDetachedPanel() {
    if (this._panel) {
      this._panel.reveal(vscode5.ViewColumn.Active);
      try {
        await vscode5.commands.executeCommand("workbench.action.moveEditorToNewWindow");
      } catch {
      }
      return;
    }
    this._panel = vscode5.window.createWebviewPanel(
      "antigravitySwap.detachedDashboard",
      "Antigravity Swap Dashboard",
      vscode5.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri]
      }
    );
    this._panel.iconPath = {
      light: vscode5.Uri.joinPath(this.extensionUri, "media", "icon.png"),
      dark: vscode5.Uri.joinPath(this.extensionUri, "media", "icon.png")
    };
    this._panel.webview.html = this.getHtmlContent(this._panel.webview);
    this._panel.webview.onDidReceiveMessage((data) => this.handleWebviewMessage(data));
    this._panel.onDidDispose(() => {
      this._panel = void 0;
    });
    this.updateWebview();
    setTimeout(async () => {
      try {
        await vscode5.commands.executeCommand("workbench.action.moveEditorToNewWindow");
      } catch (e) {
        console.warn("[Antigravity Swap] Could not auto-move to new window:", e);
      }
    }, 100);
  }
  async handleWebviewMessage(data) {
    console.log("[Antigravity Swap] Webview message:", data);
    try {
      switch (data.command) {
        case "popOut":
          this.openDetachedPanel();
          break;
        case "switchAccount":
          await this.accountManager.switchAccount(data.email, data.isManual === true);
          break;
        case "relogin":
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
        case "refreshMultipleAccounts":
          if (Array.isArray(data.emails) && data.emails.length > 0) {
            await this.accountManager.refreshMultipleAccounts(data.emails);
          }
          break;
        case "removeMultipleAccounts":
          if (Array.isArray(data.emails) && data.emails.length > 0) {
            await this.accountManager.removeMultipleAccounts(data.emails);
          }
          break;
        case "removeAccount":
          if (data.confirmed) {
            await this.accountManager.removeAccount(data.email);
          } else {
            const confirm = await vscode5.window.showWarningMessage(
              `Remove account ${data.email} from Antigravity Swap?`,
              { modal: true },
              "Remove"
            );
            if (confirm === "Remove") {
              await this.accountManager.removeAccount(data.email);
            }
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
  }
  updateWebview() {
    const accounts = this.accountManager.getAccounts();
    const activeAccount = this.accountManager.getActiveAccount();
    const overall = this.accountManager.getOverallSummary();
    const heartbeat = this.heartbeatService.getHeartbeatInfo();
    const stateMessage = {
      type: "stateUpdate",
      accounts,
      activeAccount,
      overall,
      heartbeat,
      autoSwitchEnabled: this.accountManager.isAutoSwitchEnabled()
    };
    if (this._view) {
      this._view.webview.postMessage(stateMessage);
    }
    if (this._panel) {
      this._panel.webview.postMessage(stateMessage);
    }
  }
  getHtmlContent(webview) {
    const htmlPath = path2.join(this.extensionUri.fsPath, "dist", "webview", "index.html");
    if (!fs2.existsSync(htmlPath)) {
      return `<!DOCTYPE html><html lang="en" class="dark"><head><meta charset="UTF-8"><title>Antigravity Swap</title></head>
<body style="padding:16px;color:#f87171;font-family:sans-serif;">
  <h3>Webview bundle not found</h3>
  <p>Run <code>npm run build</code> to build the webview.</p>
</body></html>`;
    }
    const nonce = this.getNonce();
    let html = fs2.readFileSync(htmlPath, "utf8");
    html = html.replace(/<script(\b[^>]*)>/, (_match, attrs) => {
      return `<script${attrs} nonce="${nonce}">`;
    });
    const csp = [
      `default-src 'none'`,
      `style-src 'unsafe-inline'`,
      `img-src ${webview.cspSource} https: data: blob:`,
      `font-src 'unsafe-inline' data:`,
      `script-src 'nonce-${nonce}' 'unsafe-eval'`
    ].join("; ");
    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
    html = html.replace("<head>", `<head>
  ${cspMeta}`);
    return html;
  }
  getNonce() {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
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
  const webviewProvider = new WebviewProvider(context.extensionUri, accountManager, heartbeatService);
  context.subscriptions.push(
    vscode7.window.registerWebviewViewProvider(WebviewProvider.viewType, webviewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  accountManager.initialize().catch((err) => {
    console.error("[Antigravity Swap] AccountManager initialization error:", err);
  });
  const config = vscode7.workspace.getConfiguration(CONFIG_KEYS.SECTION);
  const heartbeatSec = config.get(CONFIG_KEYS.HEARTBEAT_INTERVAL, EXTENSION_DEFAULTS.DEFAULT_HEARTBEAT_SECONDS);
  heartbeatService.start(heartbeatSec);
  context.subscriptions.push(heartbeatService);
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
    vscode7.commands.registerCommand("antigravitySwap.popOutDashboard", () => {
      webviewProvider.openDetachedPanel();
    }),
    vscode7.commands.registerCommand("antigravitySwap.openDashboard", () => {
      webviewProvider.openDetachedPanel();
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
