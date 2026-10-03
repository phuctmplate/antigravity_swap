import * as http from 'http';
import * as https from 'https';
import * as url from 'url';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { OAuthTokens } from './types';
import { OAUTH_CONFIG, API_ENDPOINTS } from './constants';

export class OAuthService {
  /**
   * Signs in a Google account via browser OAuth flow.
   */
  public async loginWithGoogle(loginHint?: string): Promise<{ tokens: OAuthTokens; userInfo: { email: string; name: string; avatarUrl?: string } }> {
    return this.startOAuthServerFlow(loginHint);
  }

  /**
   * Starts local HTTP callback server on first available port and initiates Google OAuth in browser.
   */
  private async startOAuthServerFlow(loginHint?: string): Promise<{ tokens: OAuthTokens; userInfo: { email: string; name: string; avatarUrl?: string } }> {
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
      let activeServer: http.Server | null = server;
      const timeoutId = setTimeout(() => {
        if (activeServer) {
          activeServer.close();
          activeServer = null;
        }
        reject(new Error('Google login timed out after 3 minutes.'));
      }, 180000);

      const cleanup = () => {
        clearTimeout(timeoutId);
        if (activeServer) {
          activeServer.close();
          activeServer = null;
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
              reject(new Error(`OAuth Error: ${error}`));
              return;
            }

            if (queryState !== state || !code) {
              res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(this.getHtmlResponse('Invalid State', 'OAuth state verification failed.', false));
              cleanup();
              reject(new Error('Invalid OAuth state parameter'));
              return;
            }

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.getHtmlResponse('Account Connected!', 'Returning to Antigravity IDE...', true));
            cleanup();

            try {
              const tokens = await this.exchangeCodeForTokens(code, redirectUri);
              const userInfo = await this.fetchUserInfo(tokens.accessToken);
              resolve({ tokens, userInfo });
            } catch (exchangeErr: any) {
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
    const color = isSuccess ? '#38bdf8' : '#ef4444';
    const uriScheme = vscode.env?.uriScheme || 'vscode';

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
