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
var vscode5 = __toESM(require("vscode"));

// src/storage.ts
var path = __toESM(require("path"));
var os = __toESM(require("os"));
var fs = __toESM(require("fs"));
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
    } catch (e) {
      console.warn(`[StorageService] Could not open SQLite via node:sqlite at ${dbPath}:`, e);
    }
    return null;
  }
  /**
   * Directly updates Antigravity IDE global state database so the internal IDE runtime
   * immediately synchronizes credentials without requiring window reload.
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
      const db = this.getSqliteDb(stateDbPath);
      if (!db) return false;
      const authStatus = JSON.stringify({
        name: account.name,
        email: account.email,
        apiKey: tokens.accessToken
      });
      const upsertStmt = db.prepare(
        "INSERT INTO ItemTable (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      );
      upsertStmt.run("antigravityAuthStatus", authStatus);
      if (tokens.accessToken) {
        const unifiedToken = this.encodeUnifiedSyncToken(
          tokens.accessToken,
          tokens.refreshToken || "",
          tokens.expiresAt || Date.now() + 36e5
        );
        upsertStmt.run("antigravityUnifiedStateSync.oauthToken", unifiedToken);
      }
      try {
        db.close();
      } catch {
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
      const db = this.getSqliteDb(cloudDbPath);
      if (!db) return false;
      const account = db.prepare("SELECT id FROM accounts WHERE email = ?").get(email);
      if (account && account.id) {
        db.prepare("UPDATE accounts SET is_active = 0").run();
        db.prepare("UPDATE accounts SET is_active = 1, last_used = ? WHERE id = ?").run(
          Math.floor(Date.now() / 1e3),
          account.id
        );
        const upsertSetting = db.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        );
        upsertSetting.run("active_cloud_account.classic", JSON.stringify(account.id));
        upsertSetting.run("active_cloud_account.ide", JSON.stringify(account.id));
      }
      try {
        db.close();
      } catch {
      }
      return true;
    } catch (err) {
      console.warn("[Antigravity Swap] Optional cloud_accounts.db sync skipped:", err);
      return false;
    }
  }
  /**
   * Helper to detect and import previous accounts from existing state.vscdb and .antigravity-agent/cloud_accounts.db
   */
  async discoverExistingAccounts() {
    const discovered = /* @__PURE__ */ new Map();
    try {
      const stateDbPath = path.join(
        os.homedir(),
        "AppData",
        "Roaming",
        "Antigravity IDE",
        "User",
        "globalStorage",
        "state.vscdb"
      );
      if (fs.existsSync(stateDbPath)) {
        const db = this.getSqliteDb(stateDbPath);
        if (db) {
          const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("antigravityAuthStatus");
          if (row && row.value) {
            try {
              const parsed = JSON.parse(row.value);
              if (parsed.email) {
                discovered.set(parsed.email, {
                  email: parsed.email,
                  name: parsed.name || parsed.email.split("@")[0],
                  accessToken: parsed.apiKey
                });
              }
            } catch {
            }
          }
          const davisRow = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("Davissss2.antigravity-account");
          if (davisRow && davisRow.value) {
            try {
              const parsedDavis = JSON.parse(davisRow.value);
              const list = parsedDavis["antigravity.accounts.list"] || [];
              for (const item of list) {
                if (item.email) {
                  const existing = discovered.get(item.email) || {
                    email: item.email,
                    name: item.name || item.email
                  };
                  discovered.set(item.email, {
                    ...existing,
                    name: item.name || existing.name,
                    avatarUrl: item.avatarUrl || existing.avatarUrl
                  });
                }
              }
            } catch {
            }
          }
          try {
            db.close();
          } catch {
          }
        }
      }
    } catch (e) {
      console.warn("Discovery from state.vscdb skipped:", e);
    }
    try {
      const cloudDbPath = path.join(os.homedir(), ".antigravity-agent", "cloud_accounts.db");
      if (fs.existsSync(cloudDbPath)) {
        const db = this.getSqliteDb(cloudDbPath);
        if (db) {
          const rows = db.prepare("SELECT email, name, avatar_url FROM accounts").all();
          for (const r of rows) {
            if (r.email) {
              const existing = discovered.get(r.email) || {
                email: r.email,
                name: r.name || r.email
              };
              discovered.set(r.email, {
                ...existing,
                name: r.name || existing.name,
                avatarUrl: r.avatar_url || existing.avatarUrl
              });
            }
          }
          try {
            db.close();
          } catch {
          }
        }
      }
    } catch (e) {
      console.warn("Discovery from cloud_accounts.db skipped:", e);
    }
    return Array.from(discovered.values());
  }
  encodeVarint(val) {
    const bytes = [];
    let num = val;
    while (num > 127) {
      bytes.push(num & 127 | 128);
      num >>>= 7;
    }
    bytes.push(num & 127);
    return Buffer.from(bytes);
  }
  encodeLengthDelimited(fieldNumber, buf) {
    const tag = fieldNumber << 3 | 2;
    const tagBuf = this.encodeVarint(tag);
    const lenBuf = this.encodeVarint(buf.length);
    return Buffer.concat([tagBuf, lenBuf, buf]);
  }
  encodeStringField(fieldNumber, str) {
    return this.encodeLengthDelimited(fieldNumber, Buffer.from(str, "utf8"));
  }
  encodeInnerOAuth(accessToken, refreshToken = "", expiresAt = Date.now() + 36e5) {
    const parts = [];
    parts.push(this.encodeStringField(1, accessToken));
    parts.push(this.encodeStringField(2, "Bearer"));
    if (refreshToken) {
      parts.push(this.encodeStringField(3, refreshToken));
    }
    const tag4 = this.encodeVarint(4 << 3 | 0);
    const val4 = this.encodeVarint(Math.floor(expiresAt / 1e3));
    parts.push(Buffer.concat([tag4, val4]));
    return Buffer.concat(parts);
  }
  encodeUnifiedSyncToken(accessToken, refreshToken = "", expiresAt = Date.now() + 36e5) {
    const innerBuf = this.encodeInnerOAuth(accessToken, refreshToken, expiresAt);
    const innerBase64 = innerBuf.toString("base64");
    const authStateJson = JSON.stringify({
      state: "signedIn",
      context: {
        project: "",
        showProjectError: false,
        errorMessage: "",
        ineligibleMessage: "",
        verificationUrl: "",
        isGcpTos: false,
        browserOpenFailed: false,
        appealUrl: "",
        appealLinkText: ""
      }
    });
    const parts = [
      this.encodeStringField(1, "oauthTokenInfoSentinelKey"),
      this.encodeStringField(2, innerBase64),
      this.encodeStringField(3, "authStateWithContextSentinelKey"),
      this.encodeStringField(4, authStateJson)
    ];
    return Buffer.concat(parts).toString("base64");
  }
};

// src/oauthService.ts
var http = __toESM(require("http"));
var https = __toESM(require("https"));
var url = __toESM(require("url"));
var crypto = __toESM(require("crypto"));
var vscode = __toESM(require("vscode"));
var OAuthService = class _OAuthService {
  // Default Google Client ID for Antigravity / Google Cloud Code
  static CLIENT_ID = "884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com";
  static REDIRECT_PORT = 45213;
  static REDIRECT_URI = `http://127.0.0.1:${_OAuthService.REDIRECT_PORT}/callback`;
  static SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cloud-platform"
  ];
  /**
   * Starts a local loopback server and opens the browser for Google OAuth login.
   */
  async loginWithGoogle() {
    const codeVerifier = this.base64URLEncode(crypto.randomBytes(32));
    const codeChallenge = this.base64URLEncode(crypto.createHash("sha256").update(codeVerifier).digest());
    const state = crypto.randomBytes(16).toString("hex");
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", _OAuthService.CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", _OAuthService.REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", _OAuthService.SCOPES.join(" "));
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent select_account");
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    return new Promise((resolve, reject) => {
      let server = null;
      const timeoutId = setTimeout(() => {
        if (server) {
          server.close();
        }
        reject(new Error("Google login timed out after 3 minutes"));
      }, 18e4);
      server = http.createServer(async (req, res) => {
        try {
          const reqUrl = url.parse(req.url || "", true);
          if (reqUrl.pathname === "/callback") {
            const queryState = reqUrl.query.state;
            const code = reqUrl.query.code;
            const error = reqUrl.query.error;
            if (error) {
              res.writeHead(400, { "Content-Type": "text/html" });
              res.end("<h1>Login Failed</h1><p>" + error + "</p>");
              clearTimeout(timeoutId);
              server?.close();
              reject(new Error(`OAuth Error: ${error}`));
              return;
            }
            if (queryState !== state || !code) {
              res.writeHead(400, { "Content-Type": "text/html" });
              res.end("<h1>Invalid State</h1><p>State verification failed.</p>");
              clearTimeout(timeoutId);
              server?.close();
              reject(new Error("Invalid OAuth state parameter"));
              return;
            }
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`
              <!DOCTYPE html>
              <html>
              <head>
                <meta charset="utf-8">
                <title>Antigravity Swap - Login Success</title>
                <style>
                  body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                    background: #0f172a;
                    color: #f8fafc;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: 100vh;
                    margin: 0;
                  }
                  .card {
                    background: #1e293b;
                    padding: 40px;
                    border-radius: 16px;
                    text-align: center;
                    box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5), 0 8px 10px -6px rgba(0,0,0,0.5);
                    border: 1px solid #334155;
                    max-width: 420px;
                  }
                  .badge {
                    display: inline-block;
                    background: #22c55e;
                    color: white;
                    width: 56px;
                    height: 56px;
                    line-height: 56px;
                    font-size: 28px;
                    border-radius: 50%;
                    margin-bottom: 20px;
                  }
                  h1 { font-size: 24px; margin: 0 0 10px; color: #38bdf8; }
                  p { color: #94a3b8; font-size: 15px; margin: 0; }
                </style>
              </head>
              <body>
                <div class="card">
                  <div class="badge">\u2713</div>
                  <h1>Account Connected!</h1>
                  <p>You can close this tab and return to Antigravity IDE.</p>
                </div>
              </body>
              </html>
            `);
            clearTimeout(timeoutId);
            server?.close();
            try {
              const tokens = await this.exchangeCodeForTokens(code, codeVerifier);
              const userInfo = await this.fetchUserInfo(tokens.accessToken);
              resolve({ tokens, userInfo });
            } catch (err) {
              reject(err);
            }
          }
        } catch (e) {
          clearTimeout(timeoutId);
          server?.close();
          reject(e);
        }
      });
      server.listen(_OAuthService.REDIRECT_PORT, () => {
        vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));
      });
      server.on("error", (err) => {
        clearTimeout(timeoutId);
        reject(new Error(`Failed to start local OAuth server on port ${_OAuthService.REDIRECT_PORT}: ${err.message}`));
      });
    });
  }
  /**
   * Exchanges authorization code for access and refresh tokens.
   */
  async exchangeCodeForTokens(code, codeVerifier) {
    const postData = new URLSearchParams({
      client_id: _OAuthService.CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: _OAuthService.REDIRECT_URI
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
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }).toString();
    const response = await this.httpsPost("oauth2.googleapis.com", "/token", postData, {
      "Content-Type": "application/x-www-form-urlencoded"
    });
    const parsed = JSON.parse(response);
    if (parsed.error) {
      throw new Error(`Token refresh failed: ${parsed.error_description || parsed.error}`);
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
              } else {
                reject(new Error(`Failed to fetch userinfo (${res.statusCode}): ${data}`));
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
var QuotaService = class {
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
      }
    }
    try {
      const quotaData = await this.callRetrieveUserQuotaSummary(currentTokens.accessToken);
      const parsedQuotas = this.parseQuotaResponse(quotaData);
      const avgPercent = this.calculateAveragePercentage(parsedQuotas);
      return { quotas: parsedQuotas, averagePercentage: avgPercent };
    } catch (err) {
      if (err.message && err.message.includes("401") && currentTokens.refreshToken) {
        try {
          currentTokens = await this.oauthService.refreshAccessToken(currentTokens.refreshToken);
          if (onTokenRefreshed) {
            await onTokenRefreshed(currentTokens);
          }
          const quotaData = await this.callRetrieveUserQuotaSummary(currentTokens.accessToken);
          const parsedQuotas = this.parseQuotaResponse(quotaData);
          const avgPercent = this.calculateAveragePercentage(parsedQuotas);
          return { quotas: parsedQuotas, averagePercentage: avgPercent };
        } catch (retryErr) {
          console.error(`[QuotaService] Retry after refresh failed for ${account.email}:`, retryErr);
        }
      }
      if (account.quotas && account.quotas.length > 0) {
        return {
          quotas: account.quotas,
          averagePercentage: account.averageQuotaPercentage || 0
        };
      }
      return {
        quotas: this.getDefaultModelQuotas(),
        averagePercentage: 0
      };
    }
  }
  /**
   * Calls https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
   */
  callRetrieveUserQuotaSummary(accessToken) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({});
      const req = https2.request(
        {
          hostname: "cloudcode-pa.googleapis.com",
          port: 443,
          path: "/v1internal:retrieveUserQuotaSummary",
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": "AntigravitySwap/1.0",
            "Content-Length": Buffer.byteLength(data)
          }
        },
        (res) => {
          let resData = "";
          res.on("data", (chunk) => resData += chunk);
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(resData));
              } catch (e) {
                reject(new Error(`Failed to parse quota JSON response: ${resData}`));
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${resData}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }
  /**
   * Parses the raw quota summary response into a clean list of ModelQuota objects.
   */
  parseQuotaResponse(rawResponse) {
    const list = [];
    const groups = rawResponse?.response?.groups || rawResponse?.groups || [];
    for (const group of groups) {
      const buckets = group.buckets || [];
      for (const bucket of buckets) {
        if (!bucket.displayName && !bucket.bucketId) continue;
        let fraction = 1;
        if (bucket.remaining?.case === "remainingFraction") {
          fraction = typeof bucket.remaining.value === "number" ? bucket.remaining.value : 1;
        } else if (typeof bucket.remainingFraction === "number") {
          fraction = bucket.remainingFraction;
        } else if (typeof bucket.fraction === "number") {
          fraction = bucket.fraction;
        }
        fraction = Math.max(0, Math.min(1, fraction));
        const percentage = Math.round(fraction * 100);
        const resetTime = bucket.quotaInfo?.resetTime || bucket.resetTime || bucket.quotaResetUTCTimestamp;
        const resetCountdown = resetTime ? this.formatCountdown(resetTime) : void 0;
        list.push({
          id: bucket.bucketId || bucket.displayName,
          displayName: bucket.displayName || bucket.bucketId,
          description: bucket.description || group.displayName,
          remainingFraction: fraction,
          percentage,
          resetTime,
          resetCountdown,
          disabled: bucket.disabled ?? false,
          refreshText: bucket.refreshText || bucket.description
        });
      }
    }
    if (list.length === 0) {
      return this.getDefaultModelQuotas();
    }
    return list;
  }
  /**
   * Computes overall aggregate percentage across all accounts.
   */
  calculateOverallSummary(accounts) {
    if (accounts.length === 0) {
      return {
        totalAccounts: 0,
        overallPercentage: 0,
        averageActiveAccountPercentage: 0,
        highestAccountQuotaPercentage: 0,
        accountsWithHealthyQuota: 0,
        accountsLowOrDepleted: 0,
        lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    const activeAcc = accounts.find((a) => a.isActive) || accounts[0];
    let sumPercentages = 0;
    let maxPercentage = 0;
    let healthyCount = 0;
    let lowCount = 0;
    for (const acc of accounts) {
      const p = acc.averageQuotaPercentage || 0;
      sumPercentages += p;
      if (p > maxPercentage) maxPercentage = p;
      if (p >= 20) {
        healthyCount++;
      } else {
        lowCount++;
      }
    }
    const overallPct = Math.round(sumPercentages / accounts.length);
    const activePct = activeAcc ? activeAcc.averageQuotaPercentage || 0 : 0;
    return {
      totalAccounts: accounts.length,
      activeAccountEmail: activeAcc?.email,
      overallPercentage: overallPct,
      averageActiveAccountPercentage: activePct,
      highestAccountQuotaPercentage: maxPercentage,
      accountsWithHealthyQuota: healthyCount,
      accountsLowOrDepleted: lowCount,
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  calculateAveragePercentage(quotas) {
    if (!quotas || quotas.length === 0) return 0;
    const valid = quotas.filter((q) => !q.disabled);
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
        return `${days}d ${hours % 24}h`;
      }
      if (hours > 0) {
        return `${hours}h ${mins}m`;
      }
      return `${mins}m`;
    } catch {
      return "Soon";
    }
  }
  getDefaultModelQuotas() {
    return [
      { id: "gemini-3.7-flash-high", displayName: "Gemini 3.7 Flash High", remainingFraction: 1, percentage: 100 },
      { id: "gemini-3-flash", displayName: "Gemini 3 Flash", remainingFraction: 1, percentage: 100 },
      { id: "claude-sonnet-4-6", displayName: "Claude 3.7 Sonnet", remainingFraction: 1, percentage: 100 },
      { id: "claude-opus-4-6", displayName: "Claude Opus Thinking", remainingFraction: 1, percentage: 100 },
      { id: "gpt-oss-120b-medium", displayName: "GPT-OSS 120B", remainingFraction: 1, percentage: 100 }
    ];
  }
};

// src/accountManager.ts
var vscode2 = __toESM(require("vscode"));
var AccountManager = class {
  constructor(storage, oauthService, quotaService) {
    this.storage = storage;
    this.oauthService = oauthService;
    this.quotaService = quotaService;
  }
  accounts = [];
  activeEmail;
  _onDidChangeState = new vscode2.EventEmitter();
  onDidChangeState = this._onDidChangeState.event;
  async initialize() {
    this.accounts = this.storage.getAccounts();
    this.activeEmail = this.storage.getActiveAccountEmail();
    if (this.accounts.length === 0) {
      await this.importDetectedAccounts();
    }
    this.refreshAllQuotas().catch((err) => console.warn("[Antigravity Swap] Initial quota refresh failed:", err));
  }
  getAccounts() {
    return this.accounts;
  }
  getActiveAccount() {
    return this.accounts.find((a) => a.email === this.activeEmail) || this.accounts.find((a) => a.isActive);
  }
  getOverallSummary() {
    return this.quotaService.calculateOverallSummary(this.accounts);
  }
  /**
   * Switches to the given account WITHOUT reloading the Antigravity IDE window.
   */
  async switchAccount(email) {
    const target = this.accounts.find((a) => a.email === email);
    if (!target) {
      vscode2.window.showErrorMessage(`Account ${email} not found in Antigravity Swap.`);
      return false;
    }
    let tokens = await this.storage.getAccountTokens(email);
    if (!tokens || !tokens.accessToken) {
      vscode2.window.showWarningMessage(`Credentials missing for ${email}. Please sign in again.`);
      return false;
    }
    if (tokens.expiresAt && Date.now() > tokens.expiresAt - 6e4 && tokens.refreshToken) {
      try {
        tokens = await this.oauthService.refreshAccessToken(tokens.refreshToken);
        await this.storage.saveAccountTokens(email, tokens);
      } catch (err) {
        console.warn(`[Antigravity Swap] Token refresh failed before switch: ${err.message}`);
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
    await this.storage.syncToIdeStateDb(target, tokens);
    await this.storage.syncToCloudAccountsDb(email);
    try {
      await vscode2.commands.executeCommand("antigravity.handleAuthRefresh");
    } catch (err) {
      console.warn("[Antigravity Swap] antigravity.handleAuthRefresh command not available, trying language server restart");
    }
    try {
      await vscode2.commands.executeCommand("antigravity.restartLanguageServer");
    } catch (err) {
    }
    vscode2.window.showInformationMessage(`\u26A1 Switched to ${target.name || email} seamlessly without reload!`);
    this._onDidChangeState.fire();
    this.refreshAccountQuota(email).catch(() => {
    });
    return true;
  }
  /**
   * Adds an account via Google OAuth web authorization.
   */
  async addAccountViaOAuth() {
    try {
      const result = await vscode2.window.withProgress(
        {
          location: vscode2.ProgressLocation.Notification,
          title: "Antigravity Swap: Authenticating with Google...",
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
          // make active if first account
          addedAt: (/* @__PURE__ */ new Date()).toISOString(),
          status: "active",
          quotas: this.quotaService.getDefaultModelQuotas(),
          averageQuotaPercentage: 100
        };
        this.accounts.push(account);
      }
      await this.storage.saveAccounts(this.accounts);
      if (account.isActive) {
        await this.switchAccount(account.email);
      }
      vscode2.window.showInformationMessage(`Added account ${userInfo.email} to Antigravity Swap!`);
      this._onDidChangeState.fire();
      this.refreshAccountQuota(account.email).catch(() => {
      });
      return account;
    } catch (err) {
      vscode2.window.showErrorMessage(`Login failed: ${err.message}`);
      return null;
    }
  }
  /**
   * Adds an account manually via Access Token or Refresh Token input.
   */
  async addAccountManually(email, accessToken, refreshToken, name) {
    if (!email || !accessToken) {
      vscode2.window.showErrorMessage("Email and Access Token are required.");
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
    } else {
      this.accounts.push({
        id: Buffer.from(email).toString("base64").substring(0, 16),
        email,
        name: name || email.split("@")[0],
        isActive: this.accounts.length === 0,
        addedAt: (/* @__PURE__ */ new Date()).toISOString(),
        status: "active",
        quotas: this.quotaService.getDefaultModelQuotas(),
        averageQuotaPercentage: 100
      });
    }
    await this.storage.saveAccounts(this.accounts);
    vscode2.window.showInformationMessage(`Account ${email} saved successfully!`);
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
      await this.switchAccount(this.accounts[0].email);
    } else if (this.accounts.length === 0) {
      this.activeEmail = void 0;
      await this.storage.setActiveAccountEmail(void 0);
    }
    vscode2.window.showInformationMessage(`Account ${email} removed.`);
    this._onDidChangeState.fire();
  }
  /**
   * Refreshes quota balances for all accounts.
   */
  async refreshAllQuotas() {
    for (const acc of this.accounts) {
      await this.refreshAccountQuota(acc.email);
    }
    this.checkAutoSwitch();
    this._onDidChangeState.fire();
  }
  async refreshAccountQuota(email) {
    const acc = this.accounts.find((a) => a.email === email);
    if (!acc) return;
    const tokens = await this.storage.getAccountTokens(email);
    if (!tokens) return;
    const res = await this.quotaService.fetchAccountQuotas(acc, tokens, async (newTokens) => {
      await this.storage.saveAccountTokens(email, newTokens);
    });
    acc.quotas = res.quotas;
    acc.averageQuotaPercentage = res.averagePercentage;
    acc.lastRefreshedAt = (/* @__PURE__ */ new Date()).toISOString();
    acc.status = res.averagePercentage < 15 ? "low_balance" : "active";
    await this.storage.saveAccounts(this.accounts);
    this._onDidChangeState.fire();
  }
  /**
   * Auto-switches to next account with healthy quota if current account is exhausted.
   */
  async checkAutoSwitch() {
    const autoSwitch = this.storage.getAutoSwitchEnabled();
    if (!autoSwitch) return;
    const active = this.getActiveAccount();
    if (!active) return;
    const config = vscode2.workspace.getConfiguration("antigravitySwap");
    const threshold = config.get("lowQuotaThresholdPercent", 10);
    if (active.averageQuotaPercentage <= threshold) {
      const candidate = this.accounts.find((a) => a.email !== active.email && a.averageQuotaPercentage > threshold);
      if (candidate) {
        vscode2.window.showWarningMessage(
          `\u26A0\uFE0F Account ${active.email} quota is low (${active.averageQuotaPercentage}%). Auto-switching to ${candidate.email} (${candidate.averageQuotaPercentage}% left)...`
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
    for (const disc of discovered) {
      const exists = this.accounts.find((a) => a.email === disc.email);
      if (!exists) {
        this.accounts.push({
          id: Buffer.from(disc.email).toString("base64").substring(0, 16),
          email: disc.email,
          name: disc.name,
          avatarUrl: disc.avatarUrl,
          isActive: this.accounts.length === 0,
          addedAt: (/* @__PURE__ */ new Date()).toISOString(),
          status: "active",
          quotas: this.quotaService.getDefaultModelQuotas(),
          averageQuotaPercentage: 100
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
      await this.storage.saveAccounts(this.accounts);
      if (!this.activeEmail && this.accounts.length > 0) {
        this.activeEmail = this.accounts[0].email;
        await this.storage.setActiveAccountEmail(this.activeEmail);
      }
      this._onDidChangeState.fire();
    }
    return addedCount;
  }
};

// src/statusBar.ts
var vscode3 = __toESM(require("vscode"));
var StatusBarService = class {
  constructor(accountManager) {
    this.accountManager = accountManager;
    this.statusBarItem = vscode3.window.createStatusBarItem(
      vscode3.StatusBarAlignment.Right,
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
    const active = this.accountManager.getActiveAccount();
    const overall = this.accountManager.getOverallSummary();
    if (!active) {
      this.statusBarItem.text = "$(account) Antigravity Swap: No Account";
      this.statusBarItem.tooltip = "Click to connect Google/Antigravity account";
      this.statusBarItem.backgroundColor = void 0;
      return;
    }
    const activePct = active.averageQuotaPercentage ?? 0;
    const overallPct = overall.overallPercentage ?? 0;
    let icon = "$(zap)";
    if (activePct < 20) {
      icon = "$(warning)";
      this.statusBarItem.backgroundColor = new vscode3.ThemeColor("statusBarItem.warningBackground");
    } else {
      this.statusBarItem.backgroundColor = void 0;
    }
    const displayName = active.name ? active.name.split(" ")[0] : active.email.split("@")[0];
    this.statusBarItem.text = `${icon} ${displayName}: ${activePct}% | All: ${overallPct}%`;
    const lines = [
      `\u26A1 Antigravity Swap - Account & Quota Status`,
      `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`,
      `\u{1F464} Active: ${active.name || active.email} (${active.email})`,
      `\u{1F4CA} Active Account Quota: ${activePct}%`,
      `\u{1F310} Overall Across ${overall.totalAccounts} Account(s): ${overallPct}%`,
      ``,
      `--- Model Quotas (${active.email}) ---`
    ];
    if (active.quotas && active.quotas.length > 0) {
      for (const q of active.quotas.slice(0, 6)) {
        const bar = this.getProgressBar(q.percentage);
        lines.push(`\u2022 ${q.displayName}: ${bar} ${q.percentage}% ${q.resetCountdown ? "(" + q.resetCountdown + ")" : ""}`);
      }
    }
    lines.push(``, `\u{1F449} Click to switch accounts or view detailed dashboard`);
    this.statusBarItem.tooltip = new vscode3.MarkdownString(lines.join("\n"));
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
      label: `\u{1F310} Overall Quota: ${overall.overallPercentage}% across ${overall.totalAccounts} account(s)`,
      description: `Active: ${active ? active.email : "None"} (${active ? active.averageQuotaPercentage : 0}%)`,
      kind: vscode3.QuickPickItemKind.Separator
    });
    for (const acc of accounts) {
      const isAct = acc.email === active?.email;
      const statusIcon = isAct ? "$(check)" : "$(account)";
      const quotaPct = acc.averageQuotaPercentage ?? 0;
      items.push({
        label: `${statusIcon} ${acc.name || acc.email}`,
        description: `${acc.email} \u2014 ${quotaPct}% quota left`,
        detail: isAct ? "\u2605 CURRENTLY ACTIVE" : "Click to switch without reloading",
        buttons: [
          {
            iconPath: new vscode3.ThemeIcon("trash"),
            tooltip: "Remove account"
          }
        ]
      });
    }
    items.push({
      label: "Actions",
      kind: vscode3.QuickPickItemKind.Separator
    });
    items.push({
      label: "$(add) Add Account (Google OAuth)",
      description: "Sign in with Google via Browser"
    });
    items.push({
      label: "$(key) Add Account Manually",
      description: "Paste Access Token / Refresh Token"
    });
    items.push({
      label: "$(refresh) Refresh All Quotas",
      description: "Fetch real-time quota balances now"
    });
    items.push({
      label: "$(dashboard) Open Quota Dashboard Panel",
      description: "View full charts and model breakdown"
    });
    const selected = await vscode3.window.showQuickPick(items, {
      placeHolder: "Select an account to switch or an action"
    });
    if (!selected) return;
    if (selected.label.includes("Add Account (Google OAuth)")) {
      await vscode3.commands.executeCommand("antigravitySwap.addAccount");
    } else if (selected.label.includes("Add Account Manually")) {
      await vscode3.commands.executeCommand("antigravitySwap.addAccountManual");
    } else if (selected.label.includes("Refresh All Quotas")) {
      await vscode3.commands.executeCommand("antigravitySwap.refreshQuotas");
    } else if (selected.label.includes("Open Quota Dashboard Panel")) {
      await vscode3.commands.executeCommand("antigravitySwap.openDashboard");
    } else {
      const matched = accounts.find((a) => selected.description?.includes(a.email) || selected.label.includes(a.email));
      if (matched) {
        await this.accountManager.switchAccount(matched.email);
      }
    }
  }
  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
};

// src/webviewProvider.ts
var vscode4 = __toESM(require("vscode"));
var WebviewProvider = class {
  constructor(extensionUri, accountManager) {
    this.extensionUri = extensionUri;
    this.accountManager = accountManager;
    this.accountManager.onDidChangeState(() => this.updateWebview());
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
      switch (data.command) {
        case "switchAccount":
          await this.accountManager.switchAccount(data.email);
          break;
        case "refreshAll":
          await vscode4.commands.executeCommand("antigravitySwap.refreshQuotas");
          break;
        case "refreshAccount":
          await this.accountManager.refreshAccountQuota(data.email);
          break;
        case "addOAuth":
          await vscode4.commands.executeCommand("antigravitySwap.addAccount");
          break;
        case "addManual":
          await vscode4.commands.executeCommand("antigravitySwap.addAccountManual");
          break;
        case "removeAccount":
          const confirm = await vscode4.window.showWarningMessage(
            `Remove account ${data.email} from Antigravity Swap?`,
            { modal: true },
            "Remove"
          );
          if (confirm === "Remove") {
            await this.accountManager.removeAccount(data.email);
          }
          break;
        case "toggleAutoSwitch":
          break;
        case "ready":
          this.updateWebview();
          break;
      }
    });
    this.updateWebview();
  }
  updateWebview() {
    if (!this._view) return;
    const accounts = this.accountManager.getAccounts();
    const activeAccount = this.accountManager.getActiveAccount();
    const overall = this.accountManager.getOverallSummary();
    this._view.webview.postMessage({
      type: "stateUpdate",
      accounts,
      activeAccount,
      overall,
      autoSwitchEnabled: true
    });
  }
  getHtmlContent(webview) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Antigravity Swap</title>
  <style>
    :root {
      --bg-gradient: linear-gradient(145deg, #090d16 0%, #111827 100%);
      --card-bg: rgba(26, 34, 52, 0.7);
      --card-border: rgba(59, 130, 246, 0.2);
      --card-border-active: rgba(96, 165, 250, 0.8);
      --neon-blue: #38bdf8;
      --neon-purple: #a855f7;
      --neon-pink: #ec4899;
      --neon-green: #22c55e;
      --neon-amber: #f59e0b;
      --neon-red: #ef4444;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      user-select: none;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg-gradient);
      color: var(--text-main);
      padding: 12px;
      font-size: 12px;
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* Overall Quota Hero Banner */
    .hero-banner {
      background: radial-gradient(circle at 50% 0%, rgba(56, 189, 248, 0.15), transparent 70%),
                  linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(15, 23, 42, 0.9));
      border: 1px solid rgba(56, 189, 248, 0.3);
      border-radius: 16px;
      padding: 16px;
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 16px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 0 20px rgba(56, 189, 248, 0.1);
      backdrop-filter: blur(12px);
      position: relative;
      overflow: hidden;
    }

    .hero-banner::after {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: linear-gradient(45deg, transparent 45%, rgba(255,255,255,0.03) 50%, transparent 55%);
      pointer-events: none;
    }

    .radial-gauge {
      width: 72px;
      height: 72px;
      position: relative;
      flex-shrink: 0;
    }

    .radial-gauge svg {
      transform: rotate(-90deg);
      width: 72px;
      height: 72px;
    }

    .gauge-bg {
      fill: none;
      stroke: rgba(255, 255, 255, 0.08);
      stroke-width: 6;
    }

    .gauge-fill {
      fill: none;
      stroke: url(#gauge-gradient);
      stroke-width: 6;
      stroke-linecap: round;
      transition: stroke-dashoffset 0.8s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .gauge-text {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 16px;
      font-weight: 800;
      color: #fff;
      text-shadow: 0 0 10px rgba(56, 189, 248, 0.5);
    }

    .hero-info {
      flex: 1;
    }

    .hero-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--neon-blue);
      font-weight: 700;
      margin-bottom: 2px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .hero-subtitle {
      font-size: 14px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 4px;
    }

    .hero-stats {
      display: flex;
      gap: 8px;
      font-size: 11px;
      color: var(--text-muted);
    }

    .stat-pill {
      background: rgba(255, 255, 255, 0.06);
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    /* Action Buttons Bar */
    .actions-bar {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 16px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 12px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.2s ease;
      text-decoration: none;
    }

    .btn-primary {
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      color: #fff;
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
    }

    .btn-primary:hover {
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(37, 99, 235, 0.4);
    }

    .btn-secondary {
      background: rgba(30, 41, 59, 0.8);
      color: #e2e8f0;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .btn-secondary:hover {
      background: rgba(51, 65, 85, 0.9);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .btn-icon {
      padding: 6px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: var(--text-muted);
      cursor: pointer;
    }

    .btn-icon:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.1);
    }

    /* Section Headers */
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      font-weight: 700;
    }

    /* Account Cards */
    .accounts-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 20px;
    }

    .account-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 12px;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
      cursor: pointer;
    }

    .account-card:hover {
      border-color: rgba(96, 165, 250, 0.5);
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.3);
    }

    .account-card.active {
      background: linear-gradient(135deg, rgba(30, 58, 138, 0.4), rgba(17, 24, 39, 0.8));
      border: 1.5px solid var(--card-border-active);
      box-shadow: 0 0 16px rgba(56, 189, 248, 0.25);
    }

    .account-card.active::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 4px;
      height: 100%;
      background: linear-gradient(to bottom, #38bdf8, #818cf8);
    }

    .acc-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }

    .acc-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: linear-gradient(135deg, #3b82f6, #ec4899);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      color: #fff;
      font-size: 13px;
      overflow: hidden;
      flex-shrink: 0;
      border: 1.5px solid rgba(255, 255, 255, 0.2);
    }

    .acc-avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .acc-meta {
      flex: 1;
      min-width: 0;
    }

    .acc-name-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .acc-name {
      font-weight: 700;
      font-size: 13px;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .active-badge {
      font-size: 9px;
      font-weight: 800;
      background: #0284c7;
      color: #fff;
      padding: 1px 6px;
      border-radius: 4px;
      letter-spacing: 0.05em;
    }

    .acc-email {
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .acc-quota-bar-wrapper {
      margin-top: 6px;
    }

    .acc-quota-label-row {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      margin-bottom: 4px;
    }

    .quota-pct {
      font-weight: 700;
      color: var(--neon-blue);
    }

    .progress-bar-bg {
      height: 6px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      overflow: hidden;
    }

    .progress-bar-fill {
      height: 100%;
      border-radius: 999px;
      transition: width 0.6s ease;
    }

    .fill-green { background: linear-gradient(90deg, #10b981, #22c55e); }
    .fill-amber { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
    .fill-red { background: linear-gradient(90deg, #ef4444, #f87171); }

    .acc-actions {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }

    /* Model Quotas Breakdown */
    .models-grid {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 20px;
    }

    .model-card {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 10px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .model-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .model-name {
      font-weight: 600;
      font-size: 12px;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .model-pill {
      font-size: 9px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(56, 189, 248, 0.15);
      color: var(--neon-blue);
    }

    .model-reset {
      font-size: 10px;
      color: var(--text-muted);
    }

    .model-bar-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .model-bar-row .progress-bar-bg {
      flex: 1;
    }

    .model-pct {
      font-size: 11px;
      font-weight: 700;
      width: 35px;
      text-align: right;
    }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 30px 16px;
      background: var(--card-bg);
      border-radius: 14px;
      border: 1px dashed rgba(255, 255, 255, 0.15);
      margin-bottom: 20px;
    }

    .empty-icon {
      font-size: 32px;
      margin-bottom: 10px;
    }

    .empty-text {
      color: var(--text-muted);
      font-size: 12px;
      margin-bottom: 14px;
    }
  </style>
</head>
<body>
  <!-- Hero Section: Overall Quota Across All Accounts -->
  <div class="hero-banner">
    <div class="radial-gauge">
      <svg viewBox="0 0 72 72">
        <defs>
          <linearGradient id="gauge-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#38bdf8" />
            <stop offset="50%" stop-color="#818cf8" />
            <stop offset="100%" stop-color="#ec4899" />
          </linearGradient>
        </defs>
        <circle class="gauge-bg" cx="36" cy="36" r="30" />
        <circle id="overall-gauge" class="gauge-fill" cx="36" cy="36" r="30" stroke-dasharray="188.5" stroke-dashoffset="188.5" />
      </svg>
      <div id="overall-pct-text" class="gauge-text">0%</div>
    </div>
    <div class="hero-info">
      <div class="hero-title">\u26A1 Antigravity Swap</div>
      <div class="hero-subtitle">Overall Total Quota</div>
      <div class="hero-stats">
        <span id="acc-count-pill" class="stat-pill">0 Accounts</span>
        <span id="active-acc-pill" class="stat-pill">No Active</span>
      </div>
    </div>
  </div>

  <!-- Action Bar -->
  <div class="actions-bar">
    <button class="btn btn-primary" onclick="addOAuth()">
      <span>+ Google Sign In</span>
    </button>
    <button class="btn btn-secondary" onclick="refreshAll()">
      <span>\u21BB Refresh Quotas</span>
    </button>
  </div>

  <!-- Accounts List Section -->
  <div class="section-header">
    <span>Accounts & Fast Switch</span>
    <button class="btn-icon" title="Add token manually" onclick="addManual()">+ Manual</button>
  </div>
  <div id="accounts-container" class="accounts-list">
    <!-- Rendered dynamically -->
  </div>

  <!-- Active Models Quota Breakdown -->
  <div class="section-header">
    <span id="models-title">Active Account Models</span>
  </div>
  <div id="models-container" class="models-grid">
    <!-- Rendered dynamically -->
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const circumference = 2 * Math.PI * 30; // ~188.5

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'stateUpdate') {
        renderState(msg);
      }
    });

    function addOAuth() {
      vscode.postMessage({ command: 'addOAuth' });
    }

    function addManual() {
      vscode.postMessage({ command: 'addManual' });
    }

    function refreshAll() {
      vscode.postMessage({ command: 'refreshAll' });
    }

    function switchAccount(email) {
      vscode.postMessage({ command: 'switchAccount', email });
    }

    function refreshAccount(event, email) {
      event.stopPropagation();
      vscode.postMessage({ command: 'refreshAccount', email });
    }

    function removeAccount(event, email) {
      event.stopPropagation();
      vscode.postMessage({ command: 'removeAccount', email });
    }

    function getFillClass(pct) {
      if (pct > 50) return 'fill-green';
      if (pct > 20) return 'fill-amber';
      return 'fill-red';
    }

    function renderState(state) {
      const overall = state.overall || { overallPercentage: 0, totalAccounts: 0 };
      const accounts = state.accounts || [];
      const activeAccount = state.activeAccount || accounts.find(a => a.isActive);

      // 1. Update Hero Gauge
      const overallPct = overall.overallPercentage || 0;
      document.getElementById('overall-pct-text').innerText = overallPct + '%';
      const offset = circumference - (overallPct / 100) * circumference;
      document.getElementById('overall-gauge').style.strokeDashoffset = offset;
      document.getElementById('acc-count-pill').innerText = \`\${accounts.length} Account\${accounts.length !== 1 ? 's' : ''}\`;
      document.getElementById('active-acc-pill').innerText = activeAccount ? (activeAccount.name || activeAccount.email.split('@')[0]) : 'None';

      // 2. Render Accounts
      const accContainer = document.getElementById('accounts-container');
      if (accounts.length === 0) {
        accContainer.innerHTML = \`
          <div class="empty-state">
            <div class="empty-icon">\u26A1</div>
            <div class="empty-text">No accounts connected yet. Add your first Google/Antigravity account to enable fast switching and quota tracking!</div>
            <button class="btn btn-primary" onclick="addOAuth()">+ Connect Google Account</button>
          </div>
        \`;
      } else {
        accContainer.innerHTML = accounts.map(acc => {
          const isAct = activeAccount && activeAccount.email === acc.email;
          const pct = acc.averageQuotaPercentage ?? 0;
          const fillClass = getFillClass(pct);
          const avatar = acc.avatarUrl
            ? \`<img src="\${acc.avatarUrl}" alt="\${acc.name}">\`
            : (acc.name ? acc.name.charAt(0).toUpperCase() : acc.email.charAt(0).toUpperCase());

          return \`
            <div class="account-card \${isAct ? 'active' : ''}" onclick="switchAccount('\${acc.email}')">
              <div class="acc-header">
                <div class="acc-avatar">\${avatar}</div>
                <div class="acc-meta">
                  <div class="acc-name-row">
                    <span class="acc-name">\${acc.name || acc.email}</span>
                    \${isAct ? '<span class="active-badge">ACTIVE</span>' : ''}
                  </div>
                  <div class="acc-email">\${acc.email}</div>
                </div>
              </div>
              <div class="acc-quota-bar-wrapper">
                <div class="acc-quota-label-row">
                  <span style="color: var(--text-muted)">Average Quota</span>
                  <span class="quota-pct">\${pct}%</span>
                </div>
                <div class="progress-bar-bg">
                  <div class="progress-bar-fill \${fillClass}" style="width: \${pct}%"></div>
                </div>
              </div>
              <div class="acc-actions">
                <button class="btn-icon" title="Refresh this account quota" onclick="refreshAccount(event, '\${acc.email}')">\u21BB</button>
                <button class="btn-icon" title="Remove account" onclick="removeAccount(event, '\${acc.email}')">\u{1F5D1}</button>
                \${!isAct ? \`<button class="btn btn-primary" style="padding: 3px 8px; font-size: 10px;" onclick="switchAccount('\${acc.email}')">Switch</button>\` : ''}
              </div>
            </div>
          \`;
        }).join('');
      }

      // 3. Render Models for Active Account
      const modelsContainer = document.getElementById('models-container');
      const modelsTitle = document.getElementById('models-title');

      if (activeAccount && activeAccount.quotas && activeAccount.quotas.length > 0) {
        modelsTitle.innerText = \`Model Quotas (\${activeAccount.name || activeAccount.email.split('@')[0]})\`;
        modelsContainer.innerHTML = activeAccount.quotas.map(q => {
          const fillClass = getFillClass(q.percentage);
          const resetInfo = q.resetCountdown ? \`<span class="model-reset">Resets \${q.resetCountdown}</span>\` : '';
          return \`
            <div class="model-card">
              <div class="model-top">
                <span class="model-name">
                  \${q.displayName}
                </span>
                \${resetInfo}
              </div>
              <div class="model-bar-row">
                <div class="progress-bar-bg">
                  <div class="progress-bar-fill \${fillClass}" style="width: \${q.percentage}%"></div>
                </div>
                <span class="model-pct" style="color: \${q.percentage < 20 ? 'var(--neon-red)' : 'var(--text-main)'}">\${q.percentage}%</span>
              </div>
            </div>
          \`;
        }).join('');
      } else {
        modelsTitle.innerText = 'Model Quotas';
        modelsContainer.innerHTML = \`
          <div style="color: var(--text-muted); text-align: center; padding: 12px; font-size: 11px;">
            Select or connect an active account to see real-time model quotas.
          </div>
        \`;
      }
    }

    // Inform extension webview is ready
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }
};

// src/extension.ts
var refreshTimer;
async function activate(context) {
  console.log("[Antigravity Swap] Activating extension...");
  const storageService = new StorageService(context, context.secrets);
  const oauthService = new OAuthService();
  const quotaService = new QuotaService(oauthService);
  const accountManager = new AccountManager(storageService, oauthService, quotaService);
  await accountManager.initialize();
  const webviewProvider = new WebviewProvider(context.extensionUri, accountManager);
  context.subscriptions.push(
    vscode5.window.registerWebviewViewProvider(WebviewProvider.viewType, webviewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  const statusBar = new StatusBarService(accountManager);
  context.subscriptions.push(statusBar);
  context.subscriptions.push(
    vscode5.commands.registerCommand("antigravitySwap.openQuickMenu", async () => {
      await statusBar.showQuickMenu();
    }),
    vscode5.commands.registerCommand("antigravitySwap.switchAccount", async (emailArg) => {
      if (emailArg && typeof emailArg === "string") {
        await accountManager.switchAccount(emailArg);
        return;
      }
      const accounts = accountManager.getAccounts();
      if (accounts.length === 0) {
        const addChoice = await vscode5.window.showInformationMessage(
          "No accounts in Antigravity Swap. Add your first account now?",
          "Sign in with Google",
          "Cancel"
        );
        if (addChoice === "Sign in with Google") {
          await accountManager.addAccountViaOAuth();
        }
        return;
      }
      const items = accounts.map((a) => ({
        label: `${a.isActive ? "$(check) " : ""}${a.name || a.email}`,
        description: `${a.email} (${a.averageQuotaPercentage}% quota left)`,
        email: a.email
      }));
      const pick = await vscode5.window.showQuickPick(items, {
        placeHolder: "Select account to switch without reload"
      });
      if (pick) {
        await accountManager.switchAccount(pick.email);
      }
    }),
    vscode5.commands.registerCommand("antigravitySwap.addAccount", async () => {
      await accountManager.addAccountViaOAuth();
    }),
    vscode5.commands.registerCommand("antigravitySwap.addAccountManual", async () => {
      const email = await vscode5.window.showInputBox({
        title: "Add Account Manually (Step 1/3)",
        prompt: "Enter Google account email address",
        placeHolder: "user@example.com",
        ignoreFocusOut: true
      });
      if (!email) return;
      const accessToken = await vscode5.window.showInputBox({
        title: "Add Account Manually (Step 2/3)",
        prompt: "Enter OAuth Access Token (ya29...)",
        placeHolder: "ya29.a0...",
        password: true,
        ignoreFocusOut: true
      });
      if (!accessToken) return;
      const refreshToken = await vscode5.window.showInputBox({
        title: "Add Account Manually (Step 3/3 - Optional)",
        prompt: "Enter Refresh Token (1//...) for auto-renewal (optional)",
        placeHolder: "1//0g...",
        password: true,
        ignoreFocusOut: true
      });
      const name = await vscode5.window.showInputBox({
        title: "Account Nickname (Optional)",
        prompt: "Enter display name / alias for this account",
        placeHolder: email.split("@")[0],
        ignoreFocusOut: true
      });
      await accountManager.addAccountManually(email, accessToken, refreshToken, name);
    }),
    vscode5.commands.registerCommand("antigravitySwap.removeAccount", async (emailArg) => {
      let email = emailArg;
      if (!email) {
        const accounts = accountManager.getAccounts();
        const pick = await vscode5.window.showQuickPick(
          accounts.map((a) => ({ label: a.email, description: a.name })),
          { placeHolder: "Select account to remove" }
        );
        if (!pick) return;
        email = pick.label;
      }
      await accountManager.removeAccount(email);
    }),
    vscode5.commands.registerCommand("antigravitySwap.refreshQuotas", async () => {
      vscode5.window.withProgress(
        {
          location: vscode5.ProgressLocation.Notification,
          title: "Refreshing all Antigravity account quotas...",
          cancellable: false
        },
        async () => {
          await accountManager.refreshAllQuotas();
          vscode5.window.showInformationMessage("\u26A1 Quotas updated successfully!");
        }
      );
    }),
    vscode5.commands.registerCommand("antigravitySwap.importExistingAccounts", async () => {
      const count = await accountManager.importDetectedAccounts();
      if (count > 0) {
        vscode5.window.showInformationMessage(`Imported ${count} previously active account(s)!`);
      } else {
        vscode5.window.showInformationMessage("No new accounts detected on local machine.");
      }
    }),
    vscode5.commands.registerCommand("antigravitySwap.openDashboard", async () => {
      await vscode5.commands.executeCommand("antigravitySwap.dashboardView.focus");
    })
  );
  const config = vscode5.workspace.getConfiguration("antigravitySwap");
  const intervalMinutes = config.get("autoRefreshIntervalMinutes", 3);
  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1e3;
  refreshTimer = setInterval(() => {
    accountManager.refreshAllQuotas().catch((err) => {
      console.warn("[Antigravity Swap] Background quota refresh error:", err);
    });
  }, intervalMs);
  context.subscriptions.push({
    dispose: () => {
      if (refreshTimer) {
        clearInterval(refreshTimer);
      }
    }
  });
  console.log("[Antigravity Swap] Extension active!");
}
function deactivate() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
