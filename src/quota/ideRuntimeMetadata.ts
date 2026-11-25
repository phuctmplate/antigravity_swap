import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface IdeRuntimeMetadata {
  ideName: string;
  ideVersion: string;
  platform: string;
  arch: string;
  userAgent: string;
  googApiClient: string;
}

const DEFAULT_LS_VERSION = '2.35.1';
const CACHE_TTL_MS = 60_000;
let cachedLsVersion: { version: string; timestamp: number } | null = null;

/**
 * Compares two numeric semver strings (e.g. "2.35.1" vs "2.8.0").
 * Returns > 0 if a > b, < 0 if a < b, 0 if equal.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * Reads the newest valid hub_*.json discovery file from ~/.gemini/antigravity/daemon
 * to obtain the running Antigravity Language Server version (lsVersion).
 * Google Cloud Code PA gates Gemini group buckets in retrieveUserQuotaSummary on
 * current Language Server User-Agent versions (>= 2.x).
 */
export function resolveDaemonLsVersion(daemonDirOverride?: string): string | undefined {
  const now = Date.now();
  if (!daemonDirOverride && cachedLsVersion && (now - cachedLsVersion.timestamp < CACHE_TTL_MS)) {
    return cachedLsVersion.version;
  }

  try {
    const daemonDir = daemonDirOverride || path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');
    if (!fs.existsSync(daemonDir)) return undefined;

    const hubFiles = fs
      .readdirSync(daemonDir)
      .filter((name) => /^hub_\d+\.json$/i.test(name))
      .map((name) => {
        const fullPath = path.join(daemonDir, name);
        try {
          return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { fullPath: string; mtimeMs: number } => entry !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const file of hubFiles.slice(0, 5)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file.fullPath, 'utf8'));
        const ver = typeof parsed?.lsVersion === 'string' ? parsed.lsVersion.trim() : '';
        if (/^\d+\.\d+\.\d+/.test(ver)) {
          if (!daemonDirOverride) {
            cachedLsVersion = { version: ver, timestamp: now };
          }
          return ver;
        }
      } catch {}
    }
  } catch {}

  return undefined;
}

export function resetRuntimeMetadataCache(): void {
  cachedLsVersion = null;
}

/**
 * Dynamically resolves host IDE & Language Server metadata at runtime.
 * Automatically adapts when Antigravity Language Server updates (e.g. 2.35.1 -> 2.40.0)
 * via ~/.gemini/antigravity/daemon/hub_*.json without manual code changes.
 */
export function getIdeRuntimeMetadata(daemonDirOverride?: string): IdeRuntimeMetadata {
  const ideName = 'antigravity';
  const daemonVersion = resolveDaemonLsVersion(daemonDirOverride);
  const ideVersion =
    daemonVersion && compareSemver(daemonVersion, DEFAULT_LS_VERSION) >= 0
      ? daemonVersion
      : (daemonVersion || DEFAULT_LS_VERSION);

  const platform = process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'darwin'
      : 'linux';

  const arch = process.arch === 'x64'
    ? 'amd64'
    : process.arch === 'arm64'
      ? 'arm64'
      : process.arch;

  const userAgent = `${ideName}/${ideVersion} ${platform}/${arch}`;
  const googApiClient = `gl-node/${process.versions.node || '20.0.0'} gccl/${ideName}`;

  return {
    ideName,
    ideVersion,
    platform,
    arch,
    userAgent,
    googApiClient
  };
}
