import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { QuotaGroup, QuotaBucket } from '../types';
import { calculateModulatedInstantQuota } from './quotaCalculator';
import { is5HourBucket, isWeeklyBucket } from './quotaClassifier';
import { formatCountdown, parseCountdownFromDescription } from './quotaFormatters';
import { SAFE_WEEKLY_THRESHOLDS, MODEL_WEIGHTS } from '../constants';

export interface LocalAgyHubInfo {
  port: number;
  csrfToken: string;
  lsVersion?: string;
  commandLine?: string;
}

export interface IdeQuotaFetchOptions {
  expectedEmail?: string;
  cacheTtlMs?: number;
  cacheFilePath?: string;
  bypassSharedCache?: boolean;
  skipCacheRead?: boolean;
}

interface SharedIdeQuotaCacheEntry {
  email?: string;
  timestamp?: number;
  data?: IdeActiveQuotaResult;
}

interface IdeQuotaLockFile {
  pid: number;
  expiresAt: number;
}

const SHARED_IDE_QUOTA_CACHE_TTL_MS = 25_000;
const inFlightLocalQueries = new Map<string, Promise<IdeActiveQuotaResult | null>>();

function getDefaultSharedIdeCachePath(): string {
  return path.join(os.homedir(), '.antigravity-swap', '.ide-quota-cache.json');
}

function getLockFilePath(cachePath: string): string {
  return `${cachePath}.lock`;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/**
 * Atomically acquires an exclusive lock file (O_CREAT | O_EXCL via 'wx').
 * Self-recovers automatically if an existing lock is expired or held by a dead PID.
 */
export function tryAcquireIdeQuotaLock(
  lockPath: string,
  ttlMs: number,
  currentPid: number = process.pid
): boolean {
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }

  const writeExclusive = (): boolean => {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        const payload: IdeQuotaLockFile = { pid: currentPid, expiresAt: Date.now() + ttlMs };
        fs.writeFileSync(fd, JSON.stringify(payload), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err: any) {
      if (err?.code === 'EEXIST') return false;
      return false;
    }
  };

  if (writeExclusive()) return true;

  // Lock exists: check if it is stale (expired TTL or orphaned by crashed/closed IDE instance)
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const lock = JSON.parse(raw) as Partial<IdeQuotaLockFile>;
    const isExpired = typeof lock.expiresAt !== 'number' || Date.now() > lock.expiresAt;
    const isDead = typeof lock.pid !== 'number' || !isProcessAlive(lock.pid);
    if (isExpired || isDead) {
      try { fs.unlinkSync(lockPath); } catch {}
      return writeExclusive();
    }
  } catch {
    // Unparseable/corrupt lock file: recover cleanly
    try { fs.unlinkSync(lockPath); } catch {}
    return writeExclusive();
  }

  return false;
}

export function releaseIdeQuotaLock(lockPath: string, currentPid: number = process.pid): void {
  try {
    if (!fs.existsSync(lockPath)) return;
    const raw = fs.readFileSync(lockPath, 'utf8');
    const lock = JSON.parse(raw) as Partial<IdeQuotaLockFile>;
    if (lock.pid === currentPid) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

function readSharedIdeQuotaCache(cachePath: string): SharedIdeQuotaCacheEntry | null {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeSharedIdeQuotaCache(cachePath: string, entry: SharedIdeQuotaCacheEntry): void {
  try {
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = path.join(dir, `.ide-quota-cache.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmpPath, JSON.stringify(entry), 'utf8');
    try {
      fs.renameSync(tmpPath, cachePath);
    } catch {
      fs.writeFileSync(cachePath, JSON.stringify(entry), 'utf8');
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  } catch {}
}

export interface IdeActiveQuotaResult {
  email: string;
  name?: string;
  userTier?: { id?: string; name?: string; description?: string };
  planInfo?: { teamsTier?: string; planName?: string };
  fetchedAt?: number;
  geminiGroup?: QuotaGroup;
  claudeGptGroup?: QuotaGroup;
  argonGroup?: QuotaGroup;
  geminiInstantPercentage: number;
  claudeInstantPercentage: number;
  accountInstantPercentage: number;
  overallQuotaPercentage: number;
  rawGroups: any[];
}

export interface LiveIdeServerAuthState {
  reachable: boolean;
  authState: 'signedIn' | 'signedOut' | 'unknown';
  email?: string;
  hasValidAuth?: boolean;
  rejectionMessage?: string;
}

let cachedHubInfo: { info: LocalAgyHubInfo | null; allHubs: LocalAgyHubInfo[]; timestamp: number } | null = null;
const HUB_CACHE_TTL_MS = 120000; // 2 minutes for healthy hubs (invalidated immediately on 401/socket error)
const HUB_EMPTY_RETRY_TTL_MS = 15000; // 15 seconds when no running agy hub was found

/**
 * Reads the daemon hub discovery JSON file (~/.gemini/<appDataDir>/daemon/hub_<port>.json)
 * to retrieve the CSRF token and Language Server version for newer IDE builds that omit --csrf_token from CLI args.
 */
export function readHubDiscoveryFile(
  port: number,
  appDataDir = 'antigravity',
  geminiBaseDir?: string
): { csrfToken?: string; lsVersion?: string; httpPort?: number } | null {
  try {
    const baseDir = geminiBaseDir || path.join(os.homedir(), '.gemini');
    const hubJsonPath = path.join(baseDir, appDataDir, 'daemon', `hub_${port}.json`);
    if (!fs.existsSync(hubJsonPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(hubJsonPath, 'utf8'));
    return {
      csrfToken: typeof parsed?.csrfToken === 'string' ? parsed.csrfToken : undefined,
      lsVersion: typeof parsed?.lsVersion === 'string' ? parsed.lsVersion : undefined,
      httpPort: typeof parsed?.httpPort === 'number' ? parsed.httpPort : undefined
    };
  } catch {
    return null;
  }
}

/**
 * Parses `agy.exe` / `agy` command lines into LocalAgyHubInfo records, resolving CSRF tokens
 * from inline `--csrf_token=` flags (legacy) or daemon `hub_<port>.json` files (IDE 2.x+).
 */
export function parseAgyHubCommandLines(lines: string[], geminiBaseDir?: string): LocalAgyHubInfo[] {
  const candidateHubs: LocalAgyHubInfo[] = [];

  for (const line of lines) {
    const portMatch = line.match(/--hub-port=(\d+)/);
    if (!portMatch) continue;

    const port = parseInt(portMatch[1], 10);
    const csrfMatch = line.match(/--csrf_token=([a-f0-9-]+)/i);
    const appDirMatch = line.match(/--app_data_dir=([^\s"]+)/i);
    const appDataDir = appDirMatch ? appDirMatch[1] : 'antigravity';

    let csrfToken = csrfMatch?.[1];
    let lsVersion: string | undefined;

    if (!csrfToken) {
      const discovery = readHubDiscoveryFile(port, appDataDir, geminiBaseDir);
      csrfToken = discovery?.csrfToken;
      lsVersion = discovery?.lsVersion;
    }

    if (csrfToken) {
      candidateHubs.push({
        port,
        csrfToken,
        lsVersion,
        commandLine: line
      });
    }
  }

  return candidateHubs;
}

function discoverLocalAgyHubs(forceRefresh = false): { primary: LocalAgyHubInfo | null; allHubs: LocalAgyHubInfo[] } {
  const now = Date.now();
  const cacheTtl = cachedHubInfo?.info ? HUB_CACHE_TTL_MS : HUB_EMPTY_RETRY_TTL_MS;
  if (!forceRefresh && cachedHubInfo && (now - cachedHubInfo.timestamp < cacheTtl)) {
    return { primary: cachedHubInfo.info, allHubs: cachedHubInfo.allHubs };
  }

  let info: LocalAgyHubInfo | null = null;
  let candidateHubs: LocalAgyHubInfo[] = [];

  try {
    let stdout = '';
    if (process.platform === 'win32') {
      stdout = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = \'agy.exe\'\\" | Select-Object -ExpandProperty CommandLine"',
        { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }
      );
    } else {
      stdout = execSync('ps aux | grep agy | grep -- --hub-port', {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'ignore']
      });
    }

    const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
    candidateHubs = parseAgyHubCommandLines(lines);

    if (candidateHubs.length > 0) {
      // Prioritize the hub matching the active workspace (or no --add-dir for empty windows)
      let matchedHub: LocalAgyHubInfo | undefined;
      try {
        const vscode = require('vscode');
        const workspaceFolders = vscode?.workspace?.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          const workspacePaths: string[] = workspaceFolders.map((f: any) =>
            (f.uri?.fsPath || '').toLowerCase()
          );
          matchedHub = candidateHubs.find((h) => {
            const cl = (h.commandLine || '').toLowerCase();
            return workspacePaths.some((wp) => wp && cl.includes(wp));
          });
        } else {
          matchedHub = candidateHubs.find((h) => {
            const cl = (h.commandLine || '').toLowerCase();
            return !cl.includes('--add-dir=');
          });
        }
      } catch {}

      info = matchedHub || candidateHubs[0];
    }
  } catch {
    info = null;
  }

  cachedHubInfo = { info, allHubs: candidateHubs, timestamp: now };
  return { primary: info, allHubs: candidateHubs };
}

/**
 * Discovers the local agy hub port and CSRF token from running process command line arguments
 * and daemon discovery files.
 */
export function getLocalAgyHubInfo(forceRefresh = false): LocalAgyHubInfo | null {
  return discoverLocalAgyHubs(forceRefresh).primary;
}

/**
 * Discovers all running local agy hubs (e.g., across multiple open IDE windows).
 */
export function getAllLocalAgyHubs(forceRefresh = false): LocalAgyHubInfo[] {
  return discoverLocalAgyHubs(forceRefresh).allHubs;
}

/**
 * Sends a Connect-RPC JSON POST to the local agy LanguageServerService.
 */
export function callLocalAgyRpc(
  hubInfo: LocalAgyHubInfo,
  method: string,
  body: any = {},
  timeoutMs = 1500
): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: hubInfo.port,
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': hubInfo.csrfToken,
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: timeoutMs
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 401) {
            cachedHubInfo = null;
            return reject(new Error(`[LocalAgyClient] 401 CSRF token invalid`));
          }
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`[LocalAgyClient] HTTP ${res.statusCode} on ${method}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ raw: data });
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`[LocalAgyClient] Timeout (${timeoutMs}ms) calling ${method}`));
    });

    req.on('error', (err) => {
      cachedHubInfo = null;
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Returns fresh cached IDE quota for the expected email if available and not expired.
 */
export function getFreshSharedIdeQuotaCache(
  options?: IdeQuotaFetchOptions
): IdeActiveQuotaResult | null {
  if (options?.bypassSharedCache || options?.skipCacheRead) return null;
  const cachePath = options?.cacheFilePath || getDefaultSharedIdeCachePath();
  const cacheTtlMs = options?.cacheTtlMs ?? SHARED_IDE_QUOTA_CACHE_TTL_MS;
  const expectedEmail = options?.expectedEmail?.trim().toLowerCase();

  const cached = readSharedIdeQuotaCache(cachePath);
  if (
    cached?.data &&
    typeof cached.timestamp === 'number' &&
    Date.now() - cached.timestamp < cacheTtlMs
  ) {
    if (!expectedEmail || cached.data.email.toLowerCase() === expectedEmail) {
      return {
        ...cached.data,
        fetchedAt: cached.data.fetchedAt ?? cached.timestamp
      };
    }
  }
  return null;
}

export function updateSharedIdeQuotaCache(
  data: IdeActiveQuotaResult,
  cacheFilePath?: string
): void {
  const cachePath = cacheFilePath || getDefaultSharedIdeCachePath();
  const ts = data.fetchedAt ?? Date.now();
  writeSharedIdeQuotaCache(cachePath, {
    email: data.email,
    timestamp: ts,
    data: { ...data, fetchedAt: ts }
  });
}

export function clearSharedIdeQuotaCache(cacheFilePath?: string): void {
  try {
    const cachePath = cacheFilePath || getDefaultSharedIdeCachePath();
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
    }
  } catch {}
}

/**
 * Fetches the active account's real-time quota and profile directly from the local running IDE (agy).
 * Coordinates across multiple IDE instances using an exclusive OS lock file (.ide-quota-cache.lock)
 * with dead-PID / TTL self-recovery and same-process in-flight deduplication.
 * Returns null if the IDE or agy is not running or if requests fail.
 */
export async function fetchActiveAccountQuotaFromIde(
  timeoutMs = 2500,
  forceRefresh = true,
  options?: IdeQuotaFetchOptions
): Promise<IdeActiveQuotaResult | null> {
  const cachePath = options?.cacheFilePath || getDefaultSharedIdeCachePath();

  // 1. Reuse fresh shared cache written by any IDE window (zero upstream calls)
  const freshCached = getFreshSharedIdeQuotaCache(options);
  if (freshCached) {
    return freshCached;
  }

  // 2. Deduplicate concurrent calls within the same IDE extension host process
  if (!options?.bypassSharedCache) {
    const inFlight = inFlightLocalQueries.get(cachePath);
    if (inFlight) {
      return inFlight;
    }
  }

  const runFetch = async (): Promise<IdeActiveQuotaResult | null> => {
    const lockPath = getLockFilePath(cachePath);
    const lockTtlMs = timeoutMs + 1000;
    const expectedEmail = options?.expectedEmail?.trim().toLowerCase();
    let acquiredLock = false;

    const shouldCoordinateLock = !options?.bypassSharedCache && !(options?.skipCacheRead && !forceRefresh);

    if (shouldCoordinateLock) {
      acquiredLock = tryAcquireIdeQuotaLock(lockPath, lockTtlMs);
      if (!acquiredLock) {
        // Another live IDE instance holds the exclusive lock: wait briefly and check shared cache
        for (let attempt = 0; attempt < 2; attempt++) {
          await new Promise((r) => setTimeout(r, 450));
          const updated = getFreshSharedIdeQuotaCache(options);
          if (updated) {
            return updated;
          }
          // Retry acquiring lock in case the leader crashed/closed abruptly or finished with error
          acquiredLock = tryAcquireIdeQuotaLock(lockPath, lockTtlMs);
          if (acquiredLock) break;
        }
        if (!acquiredLock) {
          const fallbackCached = readSharedIdeQuotaCache(cachePath);
          if (
            fallbackCached?.data &&
            (!expectedEmail || fallbackCached.data.email.toLowerCase() === expectedEmail)
          ) {
            return fallbackCached.data;
          }
          return null;
        }
      }
    }

    try {
      const hubInfo = getLocalAgyHubInfo();
      if (!hubInfo) return null;

      // 3. Fetch RetrieveUserQuotaSummary (with forceRefresh to bypass agy's internal cache)
      const summaryRes = await callLocalAgyRpc(hubInfo, 'RetrieveUserQuotaSummary', { forceRefresh }, timeoutMs);
      const rawGroups: any[] = summaryRes?.response?.groups || summaryRes?.groups || [];
      if (!rawGroups || rawGroups.length === 0) {
        return null;
      }

      // 4. Fetch GetUserStatus for active email & tier
      let userStatus: any = {};
      try {
        const statusRes = await callLocalAgyRpc(hubInfo, 'GetUserStatus', {}, timeoutMs);
        userStatus = statusRes?.userStatus || {};
      } catch {}

      const email = (userStatus.email || '').trim().toLowerCase();
      if (!email) {
        return null;
      }

      if (expectedEmail && email !== expectedEmail) {
        // IDE hub is still switching accounts; do not pollute shared cache with previous account metrics
        return null;
      }

    let geminiGroup: QuotaGroup | undefined;
    let claudeGptGroup: QuotaGroup | undefined;
    let argonGroup: QuotaGroup | undefined;

    for (const g of rawGroups) {
      const title = (g.displayName || '').toLowerCase();
      const isArgon = title.includes('argon');
      const isGemini = title.includes('gemini') && !isArgon;
      const isClaude = title.includes('claude') || title.includes('gpt');

      const weeklyBucketRaw = g.buckets?.find((b: any) => isWeeklyBucket(b.window, b.bucketId, b.displayName));
      const fiveHourBucketRaw = g.buckets?.find((b: any) => is5HourBucket(b.window, b.bucketId, b.displayName));

      const weekly: QuotaBucket | undefined = weeklyBucketRaw
        ? {
            bucketId: weeklyBucketRaw.bucketId,
            displayName: weeklyBucketRaw.displayName || 'Weekly Limit Remaining',
            window: 'weekly',
            percentage: Math.round((weeklyBucketRaw.remainingFraction ?? 0) * 100),
            remainingFraction: weeklyBucketRaw.remainingFraction ?? 0,
            resetTime: weeklyBucketRaw.resetTime,
            resetCountdown:
              parseCountdownFromDescription(weeklyBucketRaw.description) ||
              (weeklyBucketRaw.resetTime ? formatCountdown(weeklyBucketRaw.resetTime) : undefined)
          }
        : undefined;

      const fiveHour: QuotaBucket | undefined = fiveHourBucketRaw
        ? {
            bucketId: fiveHourBucketRaw.bucketId,
            displayName: fiveHourBucketRaw.displayName || 'Five Hour Limit Remaining',
            window: '5h',
            percentage: Math.round((fiveHourBucketRaw.remainingFraction ?? 0) * 100),
            remainingFraction: fiveHourBucketRaw.remainingFraction ?? 0,
            resetTime: fiveHourBucketRaw.resetTime,
            resetCountdown:
              parseCountdownFromDescription(fiveHourBucketRaw.description) ||
              (fiveHourBucketRaw.resetTime ? formatCountdown(fiveHourBucketRaw.resetTime) : undefined)
          }
        : undefined;

      const groupObj: QuotaGroup = {
        id: isGemini ? 'gemini' : isClaude ? 'claude_gpt' : isArgon ? 'argon' : g.displayName,
        name: g.displayName,
        description: g.description,
        weekly,
        fiveHour,
        buckets: [weekly, fiveHour].filter((b): b is QuotaBucket => Boolean(b))
      };

      if (isGemini) geminiGroup = groupObj;
      else if (isClaude) claudeGptGroup = groupObj;
      else if (isArgon) argonGroup = groupObj;
    }

    // Calculate instant quotas modulated by weekly capacity
    let geminiInstant = 0;
    if (geminiGroup?.fiveHour && geminiGroup?.weekly) {
      geminiInstant = calculateModulatedInstantQuota(
        geminiGroup.fiveHour.percentage,
        geminiGroup.weekly.percentage,
        SAFE_WEEKLY_THRESHOLDS.GEMINI
      );
    } else if (geminiGroup?.fiveHour) {
      geminiInstant = geminiGroup.fiveHour.percentage;
    } else if (geminiGroup?.weekly) {
      geminiInstant = geminiGroup.weekly.percentage;
    }

    let claudeInstant = 0;
    if (claudeGptGroup?.fiveHour && claudeGptGroup?.weekly) {
      claudeInstant = calculateModulatedInstantQuota(
        claudeGptGroup.fiveHour.percentage,
        claudeGptGroup.weekly.percentage,
        SAFE_WEEKLY_THRESHOLDS.CLAUDE_GPT
      );
    } else if (claudeGptGroup?.fiveHour) {
      claudeInstant = claudeGptGroup.fiveHour.percentage;
    } else if (claudeGptGroup?.weekly) {
      claudeInstant = claudeGptGroup.weekly.percentage;
    }

    const accountInstant = Math.round(
      geminiInstant * MODEL_WEIGHTS.GEMINI + claudeInstant * MODEL_WEIGHTS.CLAUDE
    );

    const weeklyAvg =
      geminiGroup?.weekly && claudeGptGroup?.weekly
        ? Math.round(
            (geminiGroup.weekly.percentage * MODEL_WEIGHTS.GEMINI) +
            (claudeGptGroup.weekly.percentage * MODEL_WEIGHTS.CLAUDE)
          )
        : (geminiGroup?.weekly?.percentage ?? claudeGptGroup?.weekly?.percentage ?? accountInstant);

    const fetchedAt = Date.now();
    const result: IdeActiveQuotaResult = {
      email,
      name: userStatus.name,
      userTier: userStatus.userTier,
      planInfo: userStatus.planStatus?.planInfo
        ? {
            teamsTier: userStatus.planStatus.planInfo.teamsTier,
            planName: userStatus.planStatus.planInfo.planName
          }
        : undefined,
      fetchedAt,
      geminiGroup,
      claudeGptGroup,
      argonGroup,
      geminiInstantPercentage: geminiInstant,
      claudeInstantPercentage: claudeInstant,
      accountInstantPercentage: accountInstant,
      overallQuotaPercentage: weeklyAvg,
      rawGroups
    };

    if (!options?.bypassSharedCache) {
      writeSharedIdeQuotaCache(cachePath, {
        email,
        timestamp: fetchedAt,
        data: result
      });
    }

    return result;
    } catch {
      return null;
    } finally {
      if (acquiredLock) {
        releaseIdeQuotaLock(lockPath);
      }
    }
  };

  if (options?.bypassSharedCache || options?.skipCacheRead) {
    return runFetch();
  }

  const promise = runFetch().finally(() => {
    inFlightLocalQueries.delete(cachePath);
  });
  inFlightLocalQueries.set(cachePath, promise);
  return promise;
}

/**
 * Forces all running Antigravity Language Server hubs (across open IDE windows)
 * to re-read and validate credentials from stored keyring storage immediately.
 */
export async function forceReloadAllLocalAgyHubs(timeoutMs = 2500): Promise<void> {
  const hubs = getAllLocalAgyHubs(true);
  if (hubs.length === 0) return;

  await Promise.allSettled(
    hubs.map((hub) => callLocalAgyRpc(hub, 'GetAuthStatus', { forceRefresh: true }, timeoutMs))
  );
}

const TRANSIENT_NETWORK_AUTH_ERROR_RE =
  /\b(network|timeout|timed out|deadline|unavailable|offline|econnrefused|econnreset|enotfound|etimedout|eai_again|ehostunreach|socket|tls|ssl|dns|502|503|504)\b|failed to fetch|fetch failed|connection (?:refused|reset|closed|failed|timed out)/i;
const AUTH_REVOCATION_REASON_RE =
  /\b(invalid_grant|unauthenticated|unauthorized|revoked|expired|401|403)\b|sign[- ]?in|re-?login/i;

function isTransientNetworkAuthError(reason?: string): boolean {
  if (!reason) return false;
  return TRANSIENT_NETWORK_AUTH_ERROR_RE.test(reason) && !AUTH_REVOCATION_REASON_RE.test(reason);
}

/**
 * Classifies GetAuthStatus + GetUserStatus responses from agy.exe into a LiveIdeServerAuthState.
 * Network/upstream failures (empty userStatus without auth rejection, or transient network generalError)
 * resolve to 'unknown' instead of 'signedOut' so offline reconnects never strip active extension control.
 */
export function classifyLiveIdeServerAuthState(
  authRes: any,
  userRes: any,
  authFulfilled = true,
  userFulfilled = true
): LiveIdeServerAuthState {
  if (!authFulfilled && !userFulfilled) {
    return { reachable: false, authState: 'unknown' };
  }

  const authResult = authRes?.authResult;
  const hasValidAuth = authResult?.hasValidAuth;
  const rejectionMessageRaw =
    authResult?.generalError?.reason ||
    authResult?.ineligible?.reason ||
    authResult?.tosViolation?.message ||
    authResult?.uiMessage ||
    undefined;
  const rejectionMessage =
    typeof rejectionMessageRaw === 'string' && rejectionMessageRaw.trim()
      ? rejectionMessageRaw.trim()
      : undefined;

  const emailRaw = userRes?.userStatus?.email;
  const email = typeof emailRaw === 'string' && emailRaw.trim() ? emailRaw.trim().toLowerCase() : undefined;

  const explicitAuthBlock =
    Boolean(authResult?.authRequired) ||
    Boolean(authResult?.tosViolation) ||
    Boolean(authResult?.ineligible);

  if (hasValidAuth === false && !explicitAuthBlock && isTransientNetworkAuthError(rejectionMessage)) {
    return {
      reachable: true,
      authState: 'unknown',
      email,
      hasValidAuth: undefined
    };
  }

  if (hasValidAuth === false || explicitAuthBlock) {
    return {
      reachable: true,
      authState: 'signedOut',
      email: undefined,
      hasValidAuth: false,
      rejectionMessage
    };
  }

  if (email) {
    return {
      reachable: true,
      authState: 'signedIn',
      email,
      hasValidAuth: typeof hasValidAuth === 'boolean' ? hasValidAuth : undefined
    };
  }

  return {
    reachable: true,
    authState: 'unknown',
    hasValidAuth: typeof hasValidAuth === 'boolean' ? hasValidAuth : undefined
  };
}

/**
 * Queries the running Antigravity IDE Language Server (agy.exe) directly via local RPC
 * to determine whether the IDE currently holds a valid authenticated session and for which email.
 * Works reliably in packaged .vsix installs even when proposed USS APIs are restricted.
 */
export async function getLiveIdeServerAuthState(
  timeoutMs = 2500,
  forceRefresh = false
): Promise<LiveIdeServerAuthState> {
  try {
    const hubInfo = getLocalAgyHubInfo(forceRefresh);
    if (!hubInfo) {
      return { reachable: false, authState: 'unknown' };
    }

    const [authSettled, userSettled] = await Promise.allSettled([
      callLocalAgyRpc(hubInfo, 'GetAuthStatus', forceRefresh ? { forceRefresh: true } : {}, timeoutMs),
      callLocalAgyRpc(hubInfo, 'GetUserStatus', {}, timeoutMs)
    ]);

    const authRes = authSettled.status === 'fulfilled' ? authSettled.value : null;
    const userRes = userSettled.status === 'fulfilled' ? userSettled.value : null;
    return classifyLiveIdeServerAuthState(
      authRes,
      userRes,
      authSettled.status === 'fulfilled',
      userSettled.status === 'fulfilled'
    );
  } catch {
    return { reachable: false, authState: 'unknown' };
  }
}
