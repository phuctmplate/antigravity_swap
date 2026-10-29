import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { parseUserStatusBytes } from './protoUtils';
import { IdeStateDbService } from './ideStateDb';
import { readAntigravityKeyringToken } from './winCredManager';

export interface DiscoveredAccount {
  email: string;
  name: string;
  avatarUrl?: string;
  accessToken?: string;
  refreshToken?: string;
}

export class AccountDiscoveryService {
  constructor(private readonly ideDbService: IdeStateDbService) {}

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
        console.log(`[AccountDiscoveryService] Synced active account in google_accounts.json to ${email}`);
        return true;
      }
    } catch (e) {
      console.warn('[AccountDiscoveryService] syncGoogleAccountsJson warning:', e);
    }
    return false;
  }

  /**
   * Reads the currently signed-in Antigravity IDE account and active token.
   * Prioritizes live in-memory Antigravity Unified State Sync API first,
   * falling back to local state.vscdb structured storage.
   * Returns null if no active session is found (e.g. user is logged out).
   */
  public async getCurrentAntigravityAccount(): Promise<DiscoveredAccount | null> {
    // 1. Antigravity IDE v2.6+ Windows Credential Manager (gemini:antigravity)
    if (process.platform === 'win32') {
      try {
        const keyringPayload = await readAntigravityKeyringToken();
        if (keyringPayload?.id_token_email && this.isValidEmail(keyringPayload.id_token_email)) {
          return {
            email: keyringPayload.id_token_email,
            name: keyringPayload.id_token_email.split('@')[0],
            accessToken: keyringPayload.token?.access_token,
            refreshToken: keyringPayload.token?.refresh_token
          };
        }
      } catch (keyringErr) {
        console.warn('[AccountDiscoveryService] readAntigravityKeyringToken warning:', keyringErr);
      }
    }

    // 2. Prioritize live in-memory Unified State Sync
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
              const parsed = parseUserStatusBytes(statusBytes);
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
      console.warn('[AccountDiscoveryService] Error reading live account from unifiedStateSync:', e);
    }

    // 3. Fallback to state.vscdb structured query
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
      const nativeDb = this.ideDbService.getSqliteDb(stateDbPath);
      if (nativeDb) {
        try {
          // Check core Antigravity v2.6+ extension state row
          const agyRow = nativeDb.prepare('SELECT value FROM ItemTable WHERE key = ?').get('google.google-antigravity');
          let agyUsername: string | undefined;
          if (agyRow?.value) {
            try {
              const parsedAgy = JSON.parse(agyRow.value);
              const username = parsedAgy['antigravity-storage']?.['jetski.onboarding.lastLoginUsername'];
              if (username && this.isValidEmail(username)) {
                agyUsername = username;
              }
            } catch {}
          }

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
            const { email: parsedEmail, name: parsedName } = parseUserStatusBytes(usBytes);
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

          // If agyUsername was found from google.google-antigravity, prefer it
          const finalEmail = agyUsername || email;

          if (finalEmail && this.isValidEmail(finalEmail)) {
            return {
              email: finalEmail,
              name: name || finalEmail.split('@')[0],
              accessToken: accessToken || undefined,
              avatarUrl
            };
          }
        } catch {}
      }
    } catch (err) {
      console.warn('[AccountDiscoveryService] Error getting current Antigravity account:', err);
    }

    return null;
  }

  /**
   * Detects and imports previous accounts from existing state.vscdb
   */
  public async discoverExistingAccounts(): Promise<DiscoveredAccount[]> {
    const discovered: Map<string, DiscoveredAccount> = new Map();

    // Only read the currently active Antigravity session from state.vscdb.
    const current = await this.getCurrentAntigravityAccount();
    if (current) {
      discovered.set(current.email, current);
    }

    return Array.from(discovered.values());
  }
}
