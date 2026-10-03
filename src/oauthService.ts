import * as http from 'http';
import * as https from 'https';
import * as url from 'url';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { OAuthTokens } from './types';

export class OAuthService {
  // Default Google Client ID for Antigravity / Google Cloud Code
  public static readonly CLIENT_ID = '884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com';
  private static readonly REDIRECT_PORT = 45213;
  private static readonly REDIRECT_URI = `http://127.0.0.1:${OAuthService.REDIRECT_PORT}/callback`;
  private static readonly SCOPES = [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cloud-platform'
  ];

  /**
   * Starts a local loopback server and opens the browser for Google OAuth login.
   */
  public async loginWithGoogle(): Promise<{ tokens: OAuthTokens; userInfo: { email: string; name: string; avatarUrl?: string } }> {
    const codeVerifier = this.base64URLEncode(crypto.randomBytes(32));
    const codeChallenge = this.base64URLEncode(crypto.createHash('sha256').update(codeVerifier).digest());
    const state = crypto.randomBytes(16).toString('hex');

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', OAuthService.CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', OAuthService.REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', OAuthService.SCOPES.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent select_account');
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);

    return new Promise((resolve, reject) => {
      let server: http.Server | null = null;
      const timeoutId = setTimeout(() => {
        if (server) {
          server.close();
        }
        reject(new Error('Google login timed out after 3 minutes'));
      }, 180000);

      server = http.createServer(async (req, res) => {
        try {
          const reqUrl = url.parse(req.url || '', true);
          if (reqUrl.pathname === '/callback') {
            const queryState = reqUrl.query.state;
            const code = reqUrl.query.code as string;
            const error = reqUrl.query.error as string;

            if (error) {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end('<h1>Login Failed</h1><p>' + error + '</p>');
              clearTimeout(timeoutId);
              server?.close();
              reject(new Error(`OAuth Error: ${error}`));
              return;
            }

            if (queryState !== state || !code) {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end('<h1>Invalid State</h1><p>State verification failed.</p>');
              clearTimeout(timeoutId);
              server?.close();
              reject(new Error('Invalid OAuth state parameter'));
              return;
            }

            // Return success HTML page with nice animation
            res.writeHead(200, { 'Content-Type': 'text/html' });
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
                  <div class="badge">✓</div>
                  <h1>Account Connected!</h1>
                  <p>You can close this tab and return to Antigravity IDE.</p>
                </div>
              </body>
              </html>
            `);

            clearTimeout(timeoutId);
            server?.close();

            try {
              // Exchange code for tokens
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

      server.listen(OAuthService.REDIRECT_PORT, () => {
        vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));
      });

      server.on('error', (err) => {
        clearTimeout(timeoutId);
        reject(new Error(`Failed to start local OAuth server on port ${OAuthService.REDIRECT_PORT}: ${err.message}`));
      });
    });
  }

  /**
   * Exchanges authorization code for access and refresh tokens.
   */
  public async exchangeCodeForTokens(code: string, codeVerifier: string): Promise<OAuthTokens> {
    const postData = new URLSearchParams({
      client_id: OAuthService.CLIENT_ID,
      code: code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: OAuthService.REDIRECT_URI
    }).toString();

    const response = await this.httpsPost('oauth2.googleapis.com', '/token', postData, {
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
      client_id: OAuthService.CLIENT_ID,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString();

    const response = await this.httpsPost('oauth2.googleapis.com', '/token', postData, {
      'Content-Type': 'application/x-www-form-urlencoded'
    });

    const parsed = JSON.parse(response);
    if (parsed.error) {
      throw new Error(`Token refresh failed: ${parsed.error_description || parsed.error}`);
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
          hostname: 'www.googleapis.com',
          port: 443,
          path: '/oauth2/v3/userinfo',
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
              } else {
                reject(new Error(`Failed to fetch userinfo (${res.statusCode}): ${data}`));
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

  private base64URLEncode(buffer: Buffer): string {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}
