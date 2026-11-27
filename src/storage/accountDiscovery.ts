import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { parseUserStatusBytes } from './protoUtils';
import { IdeStateDbService } from './ideStateDb';
import { readAntigravityKeyringToken } from './winCredManager';
import { getLiveIdeServerAuthState, LiveIdeServerAuthState } from '../quota';

export interface DiscoveredAccount {
  email: string;
  name: string;
  avatarUrl?: string;
  accessToken?: string;
  refreshToken?: string;
}

export interface LiveIdeAuthState {
  authState: 'signedIn' | 'signedOut' | 'unknown';
  email?: string;
  rejectionMessage?: string;
}

/**
 * Resolves the Antigravity IDE global state SQLite database path across Windows, macOS, and Linux.
 */
export function getAntigravityStateDbPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
}

/**
 * Returns true if the account email belongs to a workspace/enterprise domain requiring GCP ToS.
 */
export function isGcpTosEmail(email: string): boolean {
  const lower = email.toLowerCase();
  return (
    !lower.endsWith('@gmail.com') &&
    !lower.endsWith('@googlemail.com') &&
    !lower.endsWith('@example.com')
  );
}

export class AccountDiscoveryService {
  constructor(
    private readonly ideDbService: IdeStateDbService,
    private readonly serverAuthProbe: (forceRefresh?: boolean) => Promise<LiveIdeServerAuthState> = (
      forceRefresh = false
    ) => getLiveIdeServerAuthState(2500, forceRefresh)
  ) {}

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
   * Reads the live Antigravity IDE auth state and signed-in email.
   * Prioritizes:
   * 1) Explicit signedOut from in-memory USS API
   * 2) Live Language Server (agy.exe) GetAuthStatus + GetUserStatus RPC (works even when proposed USS API is restricted in .vsix)
   * 3) Live in-memory USS userStatus + token info when USS confirms signedIn
   * 4) Disk state.vscdb fallback (skipped during post-switch verification so self-written SQLite rows are never treated as IDE proof)
   */
  public async getLiveIdeAuthState(options?: {
    skipDiskFallback?: boolean;
    forceServerRefresh?: boolean;
  }): Promise<LiveIdeAuthState> {
    let ussAuthState: 'signedIn' | 'signedOut' | 'unknown' = 'unknown';
    let unifiedSync: any = null;

    try {
      unifiedSync = (vscode as any).antigravityUnifiedStateSync;
      if (unifiedSync?.OAuthPreferences?.getAuthState) {
        try {
          const rawAuth = await unifiedSync.OAuthPreferences.getAuthState();
          const stateStr = typeof rawAuth === 'string' ? rawAuth : rawAuth?.state;
          if (stateStr === 'signedOut') {
            return { authState: 'signedOut', email: undefined };
          }
          if (stateStr === 'signedIn') {
            ussAuthState = 'signedIn';
          }
        } catch {}
      }
    } catch {}

    // Live Language Server (agy.exe) check — authoritative even in packaged .vsix installs
    try {
      const serverState = await this.serverAuthProbe(Boolean(options?.forceServerRefresh));
      if (serverState.reachable) {
        if (serverState.authState === 'signedOut') {
          return {
            authState: 'signedOut',
            email: undefined,
            rejectionMessage: serverState.rejectionMessage
          };
        }
        if (serverState.authState === 'signedIn' && serverState.email && this.isValidEmail(serverState.email)) {
          return {
            authState: 'signedIn',
            email: serverState.email.trim().toLowerCase()
          };
        }
      }
    } catch {}

    // Live in-memory USS fallback ONLY when USS authState explicitly confirms signedIn
    try {
      if (unifiedSync && ussAuthState === 'signedIn') {
        let hasValidTokenInfo = true;
        if (unifiedSync.OAuthPreferences?.getOAuthTokenInfo) {
          const tokenInfo = await unifiedSync.OAuthPreferences.getOAuthTokenInfo().catch(() => null);
          hasValidTokenInfo = Boolean(tokenInfo?.accessToken);
        }
        if (hasValidTokenInfo && unifiedSync.UserStatus?.getUserStatus) {
          const rawStatus = await unifiedSync.UserStatus.getUserStatus();
          if (rawStatus) {
            const parsed = parseUserStatusBytes(Buffer.from(rawStatus, 'base64'));
            if (parsed.email && this.isValidEmail(parsed.email)) {
              return {
                authState: 'signedIn',
                email: parsed.email.trim().toLowerCase()
              };
            }
          }
        }
      }
    } catch {}

    if (!options?.skipDiskFallback) {
      // Lightweight disk fallback (state.vscdb only, no PowerShell keyring spawn)
      const diskSession = this.readStateDbAccount();
      if (diskSession?.email && this.isValidEmail(diskSession.email)) {
        return {
          authState: 'signedIn',
          email: diskSession.email.trim().toLowerCase()
        };
      }
    }

    return { authState: 'unknown', email: undefined };
  }

  /**
   * Reads the currently signed-in Antigravity IDE account from local state.vscdb.
   */
  private readStateDbAccount(): DiscoveredAccount | null {
    const stateDbPath = getAntigravityStateDbPath();
    if (!fs.existsSync(stateDbPath)) return null;

    try {
      const nativeDb = this.ideDbService.getSqliteDb(stateDbPath);
      if (!nativeDb) return null;

      try {
        const agyRow = nativeDb.prepare('SELECT value FROM ItemTable WHERE key = ?').get('google.google-antigravity');
        let agyUsername: string | undefined;
        if (agyRow?.value) {
          try {
            const parsedAgy = JSON.parse(agyRow.value);
            const username = parsedAgy['antigravity-storage']?.['agy.onboarding.lastLoginUsername'] ||
                             parsedAgy['antigravity-storage']?.['jetski.onboarding.lastLoginUsername'];
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
    } catch (err) {
      console.warn('[AccountDiscoveryService] Error reading state.vscdb account:', err);
    }

    return null;
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
    return this.readStateDbAccount();
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
