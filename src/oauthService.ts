import * as http from 'http';
import * as https from 'https';
import * as url from 'url';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { OAuthTokens } from './types';
import { OAUTH_CONFIG, API_ENDPOINTS } from './constants';

interface ActiveOAuthSession {
  cancel: (reason?: string) => void;
  server: http.Server;
  port: number;
  loginHint?: string;
}

export class OAuthService {
  private activeSession: ActiveOAuthSession | null = null;

  /**
   * Cancels any currently pending OAuth server flow and releases the port.
   */
  public cancelCurrentLogin(reason = 'Login cancelled.'): void {
    if (this.activeSession) {
      const session = this.activeSession;
      this.activeSession = null;
      session.cancel(reason);
    }
  }

  /**
   * Checks if an OAuth login flow is currently in-flight.
   */
  public isLoginInProgress(): boolean {
    return this.activeSession !== null;
  }

  /**
   * Returns the target loginHint (email) for the active OAuth session, if any was specified.
   */
  public getActiveSessionLoginHint(): string | undefined {
    return this.activeSession?.loginHint;
  }

  /**
   * Signs in a Google account via browser OAuth flow.
   */
  public async loginWithGoogle(loginHint?: string): Promise<{ tokens: OAuthTokens; userInfo: { email: string; name: string; avatarUrl?: string } }> {
    return this.startOAuthServerFlow(loginHint);
  }

  /**
   * Starts local HTTP callback server on first available port and initiates Google OAuth in browser.
   * Cancels any previous dangling OAuth session before starting a new one.
   */
  private async startOAuthServerFlow(loginHint?: string): Promise<{ tokens: OAuthTokens; userInfo: { email: string; name: string; avatarUrl?: string } }> {
    // Abort and cleanly close any previous in-flight OAuth server so ports and listeners don't accumulate
    this.cancelCurrentLogin('Previous login cancelled in favor of a new request.');

    const { server, port } = await this.bindAvailableServer(OAUTH_CONFIG.PORTS, 0);
    const redirectUri = `http://127.0.0.1:${port}${OAUTH_CONFIG.REDIRECT_PATH}`;
    const state = crypto.randomBytes(16).toString('hex');

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', OAUTH_CONFIG.CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', OAUTH_CONFIG.SCOPES.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent select_account');
    authUrl.searchParams.set('state', state);
    if (loginHint) {
      authUrl.searchParams.set('login_hint', loginHint);
    }

    return new Promise((resolve, reject) => {
      let isSettled = false;
      let activeServer: http.Server | null = server;

      const cleanup = () => {
        clearTimeout(timeoutId);
        if (activeServer) {
          try {
            if (typeof (activeServer as any).closeAllConnections === 'function') {
              (activeServer as any).closeAllConnections();
            }
            activeServer.close();
          } catch {}
          activeServer = null;
        }
        if (this.activeSession?.server === server) {
          this.activeSession = null;
        }
      };

      const timeoutId = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          cleanup();
          reject(new Error('Google login timed out after 10 minutes.'));
        }
      }, OAUTH_CONFIG.TIMEOUT_MS);

      this.activeSession = {
        server,
        port,
        loginHint,
        cancel: (reason?: string) => {
          if (!isSettled) {
            isSettled = true;
            cleanup();
            reject(new Error(reason || 'Login cancelled.'));
          }
        }
      };

      activeServer.on('request', async (req, res) => {
        try {
          const reqUrl = url.parse(req.url || '', true);
          if (reqUrl.pathname === OAUTH_CONFIG.REDIRECT_PATH) {
            const queryState = reqUrl.query.state;
            const code = reqUrl.query.code as string;
            const error = reqUrl.query.error as string;

            if (error) {
              res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(this.getHtmlResponse('Authentication Failed', error, false));
              cleanup();
              if (!isSettled) {
                isSettled = true;
                reject(new Error(`OAuth Error: ${error}`));
              }
              return;
            }

            if (queryState !== state || !code) {
              res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(this.getHtmlResponse('Invalid State', 'OAuth state verification failed.', false));
              cleanup();
              if (!isSettled) {
                isSettled = true;
                reject(new Error('Invalid OAuth state parameter'));
              }
              return;
            }

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.getHtmlResponse('Account Connected!', 'Returning to Antigravity IDE...', true));
            cleanup();

            try {
              const tokens = await this.exchangeCodeForTokens(code, redirectUri);
              const userInfo = await this.fetchUserInfo(tokens.accessToken);
              if (!isSettled) {
                isSettled = true;
                resolve({ tokens, userInfo });
              }
            } catch (exchangeErr: any) {
              if (!isSettled) {
                isSettled = true;
                reject(exchangeErr);
              }
            }
          } else {
            res.writeHead(404);
            res.end();
          }
        } catch (e) {
          cleanup();
          if (!isSettled) {
            isSettled = true;
            reject(e);
          }
        }
      });

      vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));
    });
  }

  private bindAvailableServer(ports: readonly number[], index: number): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
      if (index >= ports.length) {
        return reject(new Error('No available local ports for OAuth callback (tried ' + ports.join(', ') + ')'));
      }
      const port = ports[index];
      const srv = http.createServer();

      srv.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          resolve(this.bindAvailableServer(ports, index + 1));
        } else {
          reject(err);
        }
      });

      srv.listen(port, '127.0.0.1', () => {
        srv.removeAllListeners('error');
        resolve({ server: srv, port });
      });
    });
  }

  private getHtmlResponse(title: string, message: string, isSuccess: boolean): string {
    const uriScheme = vscode.env?.uriScheme || 'vscode';
    const statusBg = isSuccess ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)';
    const statusBorder = isSuccess ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.25)';
    const statusColor = isSuccess ? '#10b981' : '#ef4444';

    const statusIconSvg = isSuccess
      ? `<svg class="status-icon-svg" viewBox="0 0 24 24" fill="none" stroke="${statusColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>`
      : `<svg class="status-icon-svg" viewBox="0 0 24 24" fill="none" stroke="${statusColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Antigravity Swap — ${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111726;
      --card-border: rgba(255, 255, 255, 0.08);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background-color: var(--bg);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      overflow: hidden;
      position: relative;
    }

    .bg-gradient {
      position: absolute;
      width: 600px;
      height: 600px;
      background: radial-gradient(circle, rgba(253, 63, 32, 0.08) 0%, rgba(14, 165, 233, 0.05) 50%, transparent 70%);
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      pointer-events: none;
      z-index: 0;
    }

    .card {
      position: relative;
      z-index: 10;
      width: 100%;
      max-width: 400px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: 36px 28px 28px;
      text-align: center;
      box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.6), 0 0 1px 1px rgba(255, 255, 255, 0.05);
      animation: fadeIn 0.4s ease-out forwards;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .logo-container {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      margin-bottom: 24px;
    }

    .logo-svg {
      width: 32px;
      height: 32px;
      filter: drop-shadow(0 2px 8px rgba(253, 63, 32, 0.3));
    }

    .logo-title {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: #f1f5f9;
    }

    .status-icon-wrapper {
      width: 52px;
      height: 52px;
      margin: 0 auto 18px;
      border-radius: 50%;
      background: ${statusBg};
      border: 1px solid ${statusBorder};
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .status-icon-svg {
      width: 26px;
      height: 26px;
    }

    h1 {
      font-size: 19px;
      font-weight: 700;
      color: #f8fafc;
      letter-spacing: -0.01em;
      margin-bottom: 8px;
    }

    p.subtitle {
      font-size: 13.5px;
      line-height: 1.5;
      color: var(--text-muted);
      margin-bottom: 24px;
      padding: 0 4px;
    }

    .btn-return {
      width: 100%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      background: #1e293b;
      color: #f8fafc;
      border: 1px solid rgba(255, 255, 255, 0.12);
      padding: 11px 20px;
      border-radius: 10px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .btn-return:hover {
      background: #2563eb;
      border-color: #3b82f6;
      color: #ffffff;
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
    }

    .btn-return:active {
      transform: translateY(0);
    }

    .btn-return svg {
      width: 15px;
      height: 15px;
    }

    .footer-note {
      margin-top: 16px;
      font-size: 11.5px;
      color: var(--text-dim);
    }
  </style>
</head>
<body>
  <div class="bg-gradient"></div>

  <div class="card">
    <div class="logo-container">
      <svg class="logo-svg" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M319.531 60.5C514.031 126 513 406.5 283.531 463C196.5 419.5 163 314.5 219.531 221C207 297.5 207.5 359 289.031 412.5C458 350 468.531 139 319.531 60.5Z" fill="url(#p0)"/>
        <path d="M192.292 450.5C-2.20798 385 -1.17719 104.5 228.292 48C315.323 91.5 348.823 196.5 292.292 290C304.823 213.5 304.323 152 222.792 98.5C53.8228 161 43.2921 372 192.292 450.5Z" fill="url(#p1)"/>
        <defs>
          <linearGradient id="p0" x1="325" y1="462" x2="325" y2="60.5" gradientUnits="userSpaceOnUse">
            <stop stop-color="#D41609"/>
            <stop offset="0.5" stop-color="#FD3F20"/>
            <stop offset="1" stop-color="#FF6F43"/>
          </linearGradient>
          <linearGradient id="p1" x1="187" y1="49" x2="187" y2="450.5" gradientUnits="userSpaceOnUse">
            <stop stop-color="#D41609"/>
            <stop offset="0.5" stop-color="#FD3F20"/>
            <stop offset="1" stop-color="#FF6F43"/>
          </linearGradient>
        </defs>
      </svg>
      <span class="logo-title">Antigravity Swap</span>
    </div>

    <div class="status-icon-wrapper">
      ${statusIconSvg}
    </div>

    <h1>${title}</h1>
    <p class="subtitle">${message}</p>

    <button class="btn-return" onclick="returnToIde()">
      <span>Return to Antigravity IDE</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="5" y1="12" x2="19" y2="12"></line>
        <polyline points="12 5 19 12 12 19"></polyline>
      </svg>
    </button>

    <div class="footer-note">
      You can safely close this browser tab anytime.
    </div>
  </div>

  <script>
    const uriScheme = "${uriScheme}";
    function returnToIde() {
      try {
        window.location.href = uriScheme + "://";
      } catch (e) {}
      setTimeout(() => {
        try {
          window.close();
        } catch (e) {}
      }, 500);
    }
    if (${isSuccess}) {
      setTimeout(returnToIde, 1200);
    }
  </script>
</body>
</html>`;
  }


  /**
   * Exchanges authorization code for access and refresh tokens.
   */
  public async exchangeCodeForTokens(code: string, redirectUri: string): Promise<OAuthTokens> {
    const postData = new URLSearchParams({
      client_id: OAUTH_CONFIG.CLIENT_ID,
      client_secret: OAUTH_CONFIG.CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    }).toString();

    const response = await this.httpsPost(API_ENDPOINTS.OAUTH_TOKEN_HOST, '/token', postData, {
      'Content-Type': 'application/x-www-form-urlencoded'
    });

    const parsed = JSON.parse(response);
    if (parsed.error) {
      throw new Error(`Token exchange failed: ${parsed.error_description || parsed.error}`);
    }

    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresAt: Date.now() + (parsed.expires_in || 3600) * 1000,
      tokenType: parsed.token_type || 'Bearer'
    };
  }

  /**
   * Refreshes an expired access token using the account's refresh token.
   */
  public async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    const postData = new URLSearchParams({
      client_id: OAUTH_CONFIG.CLIENT_ID,
      client_secret: OAUTH_CONFIG.CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString();

    const response = await this.httpsPost(API_ENDPOINTS.OAUTH_TOKEN_HOST, '/token', postData, {
      'Content-Type': 'application/x-www-form-urlencoded'
    });

    const parsed = JSON.parse(response);
    if (parsed.error) {
      const errCode = parsed.error;
      const errDesc = parsed.error_description || '';
      if (errCode === 'invalid_grant') {
        throw new Error(`AUTH_EXPIRED: Refresh token expired or revoked (${errDesc})`);
      }
      throw new Error(`Token refresh failed: ${errDesc || errCode}`);
    }

    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token || refreshToken,
      expiresAt: Date.now() + (parsed.expires_in || 3600) * 1000,
      tokenType: parsed.token_type || 'Bearer'
    };
  }

  /**
   * Fetches user profile (email, name, picture) using the access token.
   */
  public async fetchUserInfo(accessToken: string): Promise<{ email: string; name: string; avatarUrl?: string }> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: API_ENDPOINTS.USER_INFO_HOST,
          port: 443,
          path: API_ENDPOINTS.USER_INFO_PATH,
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': 'AntigravitySwap/1.0'
          }
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                const parsed = JSON.parse(data);
                resolve({
                  email: parsed.email,
                  name: parsed.name || parsed.email.split('@')[0],
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
      req.on('error', reject);
      req.end();
    });
  }

  private httpsPost(hostname: string, path: string, body: string, headers: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname,
          port: 443,
          path,
          method: 'POST',
          headers: {
            ...headers,
            'Content-Length': Buffer.byteLength(body),
            'User-Agent': 'AntigravitySwap/1.0'
          }
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          });
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}
