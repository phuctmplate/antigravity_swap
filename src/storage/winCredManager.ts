import * as cp from 'child_process';
import { OAuthTokens } from '../types';

export interface KeyringStoredTokenPayload {
  token?: {
    access_token?: string;
    token_type?: string;
    refresh_token?: string;
    expiry?: string;
    expires_in?: number;
  };
  auth_method?: string;
  id_token_email?: string;
}

const KEYRING_TARGET = 'gemini:antigravity';
const KEYRING_USER = 'antigravity';

const CSHARP_CRED_HELPER = `
using System;
using System.Runtime.InteropServices;
using System.Text;

public class AgyCredManager {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr cred);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    public static string ReadGeneric(string target) {
        IntPtr ptr = IntPtr.Zero;
        if (!CredRead(target, 1, 0, out ptr)) return null;
        try {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            if (cred.CredentialBlobSize == 0 || cred.CredentialBlob == IntPtr.Zero) return null;
            byte[] bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, (int)cred.CredentialBlobSize);
            return Encoding.UTF8.GetString(bytes);
        } finally {
            CredFree(ptr);
        }
    }

    public static bool WriteGeneric(string target, string user, string secret) {
        byte[] bytes = Encoding.UTF8.GetBytes(secret);
        IntPtr blobPtr = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, blobPtr, bytes.Length);
            CREDENTIAL cred = new CREDENTIAL();
            cred.Flags = 0;
            cred.Type = 1; // CRED_TYPE_GENERIC
            cred.TargetName = target;
            cred.UserName = user;
            cred.CredentialBlobSize = (uint)bytes.Length;
            cred.CredentialBlob = blobPtr;
            cred.Persist = 2; // CRED_PERSIST_LOCAL_MACHINE
            return CredWrite(ref cred, 0);
        } finally {
            Marshal.FreeHGlobal(blobPtr);
        }
    }
}
`;

/**
 * Reads the active Antigravity v2.6+ StoredToken from Windows Credential Manager (target: gemini:antigravity).
 */
export async function readAntigravityKeyringToken(): Promise<KeyringStoredTokenPayload | null> {
  if (process.platform !== 'win32') {
    return null;
  }

  return new Promise((resolve) => {
    const psScript = `
      $ErrorActionPreference = 'Stop'
      try {
        Add-Type -TypeDefinition $env:AGY_CSHARP_CODE
        $raw = [AgyCredManager]::ReadGeneric('${KEYRING_TARGET}')
        if ($raw) {
          [Console]::Out.Write($raw)
          exit 0
        }
        exit 1
      } catch {
        exit 1
      }
    `;

    cp.execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      {
        env: { ...process.env, AGY_CSHARP_CODE: CSHARP_CRED_HELPER },
        timeout: 3500,
        windowsHide: true
      },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as KeyringStoredTokenPayload;
          resolve(parsed);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/**
 * Writes the active Antigravity v2.6+ StoredToken into Windows Credential Manager (target: gemini:antigravity).
 */
export async function writeAntigravityKeyringToken(email: string, tokens: OAuthTokens): Promise<boolean> {
  if (process.platform !== 'win32' || !tokens.accessToken) {
    return false;
  }

  const expiresAtMs = tokens.expiresAt || (Date.now() + 3600 * 1000);
  const expiresInSec = Math.max(60, Math.floor((expiresAtMs - Date.now()) / 1000));
  const payload: KeyringStoredTokenPayload = {
    token: {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      refresh_token: tokens.refreshToken || '',
      expiry: new Date(expiresAtMs).toISOString(),
      expires_in: expiresInSec
    },
    auth_method: 'consumer',
    id_token_email: email
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');

  return new Promise((resolve) => {
    const psScript = `
      $ErrorActionPreference = 'Stop'
      try {
        Add-Type -TypeDefinition $env:AGY_CSHARP_CODE
        $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:AGY_CRED_B64))
        $ok = [AgyCredManager]::WriteGeneric('${KEYRING_TARGET}', '${KEYRING_USER}', $json)
        if ($ok) { exit 0 } else { exit 1 }
      } catch {
        exit 1
      }
    `;

    cp.execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      {
        env: {
          ...process.env,
          AGY_CSHARP_CODE: CSHARP_CRED_HELPER,
          AGY_CRED_B64: payloadB64
        },
        timeout: 4000,
        windowsHide: true
      },
      (err) => {
        if (err) {
          console.warn('[winCredManager] Failed to write gemini:antigravity credential:', err.message);
          resolve(false);
        } else {
          resolve(true);
        }
      }
    );
  });
}

