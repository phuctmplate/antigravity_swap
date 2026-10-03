import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
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
    } catch (e) {
      console.warn(`[StorageService] Could not open SQLite via node:sqlite at ${dbPath}:`, e);
    }
    return null;
  }

  /**
   * Directly updates Antigravity IDE global state database so the internal IDE runtime
   * immediately synchronizes credentials without requiring window reload.
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
      const db = this.getSqliteDb(stateDbPath);
      if (!db) return false;

      // 1. Update antigravityAuthStatus
      const authStatus = JSON.stringify({
        name: account.name,
        email: account.email,
        apiKey: tokens.accessToken
      });

      const upsertStmt = db.prepare(
        'INSERT INTO ItemTable (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      );
      upsertStmt.run('antigravityAuthStatus', authStatus);

      // 2. Update antigravityUnifiedStateSync.oauthToken if refresh token or expiry present
      if (tokens.accessToken) {
        const unifiedToken = this.encodeUnifiedSyncToken(
          tokens.accessToken,
          tokens.refreshToken || '',
          tokens.expiresAt || Date.now() + 3600000
        );
        upsertStmt.run('antigravityUnifiedStateSync.oauthToken', unifiedToken);
      }

      // Close db connection cleanly
      try {
        db.close();
      } catch {}

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
      const db = this.getSqliteDb(cloudDbPath);
      if (!db) return false;

      // Find account by email
      const account = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email);
      if (account && account.id) {
        // Reset all is_active to 0
        db.prepare('UPDATE accounts SET is_active = 0').run();
        // Set this account to is_active = 1
        db.prepare('UPDATE accounts SET is_active = 1, last_used = ? WHERE id = ?').run(
          Math.floor(Date.now() / 1000),
          account.id
        );

        // Update settings
        const upsertSetting = db.prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        );
        upsertSetting.run('active_cloud_account.classic', JSON.stringify(account.id));
        upsertSetting.run('active_cloud_account.ide', JSON.stringify(account.id));
      }

      try {
        db.close();
      } catch {}
      return true;
    } catch (err) {
      console.warn('[Antigravity Swap] Optional cloud_accounts.db sync skipped:', err);
      return false;
    }
  }

  /**
   * Helper to detect and import previous accounts from existing state.vscdb and .antigravity-agent/cloud_accounts.db
   */
  public async discoverExistingAccounts(): Promise<DiscoveredAccount[]> {
    const discovered: Map<string, DiscoveredAccount> = new Map();

    // 1. Check current antigravityAuthStatus in state.vscdb
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
      if (fs.existsSync(stateDbPath)) {
        const db = this.getSqliteDb(stateDbPath);
        if (db) {
          const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravityAuthStatus');
          if (row && row.value) {
            try {
              const parsed = JSON.parse(row.value);
              if (parsed.email) {
                discovered.set(parsed.email, {
                  email: parsed.email,
                  name: parsed.name || parsed.email.split('@')[0],
                  accessToken: parsed.apiKey
                });
              }
            } catch {}
          }

          // Also check Davissss2.antigravity-account for historical account list
          const davisRow = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('Davissss2.antigravity-account');
          if (davisRow && davisRow.value) {
            try {
              const parsedDavis = JSON.parse(davisRow.value);
              const list = parsedDavis['antigravity.accounts.list'] || [];
              for (const item of list) {
                if (item.email) {
                  const existing: DiscoveredAccount = discovered.get(item.email) || {
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
            } catch {}
          }

          try { db.close(); } catch {}
        }
      }
    } catch (e) {
      console.warn('Discovery from state.vscdb skipped:', e);
    }

    // 2. Check cloud_accounts.db
    try {
      const cloudDbPath = path.join(os.homedir(), '.antigravity-agent', 'cloud_accounts.db');
      if (fs.existsSync(cloudDbPath)) {
        const db = this.getSqliteDb(cloudDbPath);
        if (db) {
          const rows = db.prepare('SELECT email, name, avatar_url FROM accounts').all() as Array<{ email: string; name?: string; avatar_url?: string }>;
          for (const r of rows) {
            if (r.email) {
              const existing: DiscoveredAccount = discovered.get(r.email) || {
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
          try { db.close(); } catch {}
        }
      }
    } catch (e) {
      console.warn('Discovery from cloud_accounts.db skipped:', e);
    }

    return Array.from(discovered.values());
  }

  private encodeVarint(val: number): Buffer {
    const bytes: number[] = [];
    let num = val;
    while (num > 0x7f) {
      bytes.push((num & 0x7f) | 0x80);
      num >>>= 7;
    }
    bytes.push(num & 0x7f);
    return Buffer.from(bytes);
  }

  private encodeLengthDelimited(fieldNumber: number, buf: Buffer): Buffer {
    const tag = (fieldNumber << 3) | 2;
    const tagBuf = this.encodeVarint(tag);
    const lenBuf = this.encodeVarint(buf.length);
    return Buffer.concat([tagBuf, lenBuf, buf]);
  }

  private encodeStringField(fieldNumber: number, str: string): Buffer {
    return this.encodeLengthDelimited(fieldNumber, Buffer.from(str, 'utf8'));
  }

  private encodeInnerOAuth(accessToken: string, refreshToken = '', expiresAt = Date.now() + 3600000): Buffer {
    const parts: Buffer[] = [];
    parts.push(this.encodeStringField(1, accessToken));
    parts.push(this.encodeStringField(2, 'Bearer'));
    if (refreshToken) {
      parts.push(this.encodeStringField(3, refreshToken));
    }
    const tag4 = this.encodeVarint((4 << 3) | 0);
    const val4 = this.encodeVarint(Math.floor(expiresAt / 1000));
    parts.push(Buffer.concat([tag4, val4]));
    return Buffer.concat(parts);
  }

  private encodeUnifiedSyncToken(accessToken: string, refreshToken = '', expiresAt = Date.now() + 3600000): string {
    const innerBuf = this.encodeInnerOAuth(accessToken, refreshToken, expiresAt);
    const innerBase64 = innerBuf.toString('base64');

    const authStateJson = JSON.stringify({
      state: 'signedIn',
      context: {
        project: '',
        showProjectError: false,
        errorMessage: '',
        ineligibleMessage: '',
        verificationUrl: '',
        isGcpTos: false,
        browserOpenFailed: false,
        appealUrl: '',
        appealLinkText: ''
      }
    });

    const parts = [
      this.encodeStringField(1, 'oauthTokenInfoSentinelKey'),
      this.encodeStringField(2, innerBase64),
      this.encodeStringField(3, 'authStateWithContextSentinelKey'),
      this.encodeStringField(4, authStateJson)
    ];
    return Buffer.concat(parts).toString('base64');
  }
}
