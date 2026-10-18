import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { CONFIG_KEYS, EXTENSION_DEFAULTS } from '../constants';

export class DistributedSyncManager {
  private lastProcessedOAuthTimestamp = 0;
  private fileWatcher?: fs.FSWatcher;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly onExternalAccountsChanged: () => void,
    private readonly onExternalOAuthComplete: (data: { email: string; timestamp: number }) => void,
    private readonly getLastLocalSaveTime: () => number,
    private readonly getAccountsFilePath: () => string
  ) {}

  public getOAuthEventFilePath(): string {
    const dir = path.join(os.homedir(), '.antigravity-swap');
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {}
    }
    return path.join(dir, '.oauth-event.json');
  }

  /**
   * Broadcasts to other IDE windows/instances that an OAuth login completed.
   */
  public broadcastOAuthCompleted(email: string): void {
    try {
      const eventFile = this.getOAuthEventFilePath();
      const payload = {
        email,
        pid: process.pid,
        timestamp: Date.now()
      };
      fs.writeFileSync(eventFile, JSON.stringify(payload), 'utf-8');
    } catch (e) {
      console.warn('[DistributedSyncManager] Failed to broadcast OAuth event:', e);
    }
  }

  /**
   * Checks if an external IDE instance recently completed an OAuth login.
   */
  public checkExternalOAuthEvent(): void {
    try {
      const eventFile = this.getOAuthEventFilePath();
      if (!fs.existsSync(eventFile)) return;
      const raw = fs.readFileSync(eventFile, 'utf-8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && data.timestamp && data.email) {
        if (data.pid !== process.pid && data.timestamp > this.lastProcessedOAuthTimestamp && Date.now() - data.timestamp < 15000) {
          this.lastProcessedOAuthTimestamp = data.timestamp;
          this.onExternalOAuthComplete({ email: data.email, timestamp: data.timestamp });
        }
      }
    } catch {}
  }

  public initFileWatcher(): vscode.Disposable {
    const filePath = this.getAccountsFilePath();
    let debounceTimer: NodeJS.Timeout | null = null;

    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.fileWatcher = fs.watch(dir, (_eventType, filename) => {
        if (filename && filename.includes('oauth-event')) {
          this.checkExternalOAuthEvent();
          return;
        }

        if (!filename || filename === 'accounts.json' || filename.includes('accounts')) {
          if (Date.now() - this.getLastLocalSaveTime() < 800) {
            // Ignored: change caused by our own local save
            return;
          }
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            console.log('[DistributedSyncManager] Detected external accounts.json change, triggering reload.');
            this.onExternalAccountsChanged();
          }, 150);
        }
      });
    } catch (e) {
      console.warn('[DistributedSyncManager] Could not initialize file watcher:', e);
    }

    const secretWatcher = this.secrets.onDidChange((e) => {
      if (e.key.startsWith('antigravitySwap.tokens.')) {
        if (Date.now() - this.getLastLocalSaveTime() < 800) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this.onExternalAccountsChanged();
        }, 150);
      }
    });

    return {
      dispose: () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        if (this.fileWatcher) {
          try { this.fileWatcher.close(); } catch {}
        }
        secretWatcher.dispose();
      }
    };
  }

  private leaseKeepAliveTimer?: NodeJS.Timeout;
  private static readonly LEASE_KEEP_ALIVE_INTERVAL_MS = 5000;
  private static readonly LOCK_TTL_MS = 15000;

  public getHeartbeatIntervalSeconds(): number {
    return EXTENSION_DEFAULTS.DEFAULT_HEARTBEAT_SECONDS;
  }

  /**
   * Starts an asynchronous 5-second keep-alive timer while holding the active refresh lease.
   * Periodically updates startedAt to signal to other IDE instances that this instance is actively alive,
   * avoiding blocking the event loop or parallel operations.
   */
  private startLeaseKeepAlive(): void {
    this.stopLeaseKeepAlive();
    this.leaseKeepAliveTimer = setInterval(() => {
      this.renewRefreshLeaseAsync().catch(() => {});
    }, DistributedSyncManager.LEASE_KEEP_ALIVE_INTERVAL_MS);
    if (this.leaseKeepAliveTimer.unref) {
      this.leaseKeepAliveTimer.unref();
    }
  }

  private stopLeaseKeepAlive(): void {
    if (this.leaseKeepAliveTimer) {
      clearInterval(this.leaseKeepAliveTimer);
      this.leaseKeepAliveTimer = undefined;
    }
  }

  /**
   * Non-blocking asynchronous lease heartbeat update.
   */
  public async renewRefreshLeaseAsync(): Promise<void> {
    const dir = path.join(os.homedir(), '.antigravity-swap');
    const leaseFile = path.join(dir, '.refresh-lease.json');
    try {
      const content = await fs.promises.readFile(leaseFile, 'utf-8').catch(() => null);
      if (content) {
        const lease = JSON.parse(content);
        if (lease.status === 'FETCHING' && lease.pid === process.pid) {
          await fs.promises.writeFile(
            leaseFile,
            JSON.stringify({ ...lease, startedAt: Date.now() }),
            'utf-8'
          );
        }
      }
    } catch {}
  }

  /**
   * Attempts to acquire a distributed refresh lease across multiple IDE windows.
   * Prevents duplicate simultaneous API calls and enforces cooldown periods matching heartbeat settings.
   */
  public tryAcquireRefreshLease(force = false): boolean {
    const dir = path.join(os.homedir(), '.antigravity-swap');
    const leaseFile = path.join(dir, '.refresh-lease.json');
    const now = Date.now();
    const LOCK_TTL_MS = DistributedSyncManager.LOCK_TTL_MS;
    const heartbeatSec = this.getHeartbeatIntervalSeconds();
    const COOLDOWN_MS = Math.max(5000, (heartbeatSec * 1000) - 2000);

    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    }

    if (force) {
      try {
        fs.writeFileSync(leaseFile, JSON.stringify({ status: 'FETCHING', startedAt: now, pid: process.pid }), 'utf-8');
        this.startLeaseKeepAlive();
        return true;
      } catch {
        return true;
      }
    }

    try {
      if (fs.existsSync(leaseFile)) {
        const raw = fs.readFileSync(leaseFile, 'utf-8');
        const lease = JSON.parse(raw);
        const startedAt = typeof lease.startedAt === 'number' ? lease.startedAt : 0;
        const lastCompletedAt = typeof lease.lastCompletedAt === 'number' ? lease.lastCompletedAt : 0;

        // Check if an active request is in-flight within TTL
        if (lease.status === 'FETCHING' && (now - startedAt) < LOCK_TTL_MS) {
          return false;
        }

        // Check if a refresh was recently completed within cooldown
        if ((now - lastCompletedAt) < COOLDOWN_MS) {
          return false;
        }
      }

      fs.writeFileSync(leaseFile, JSON.stringify({ status: 'FETCHING', startedAt: now, pid: process.pid }), 'utf-8');
      this.startLeaseKeepAlive();
      return true;
    } catch {
      return true;
    }
  }

  /**
   * Synchronously extends the heartbeat timestamp of an active refresh lease.
   */
  public renewRefreshLease(): void {
    const dir = path.join(os.homedir(), '.antigravity-swap');
    const leaseFile = path.join(dir, '.refresh-lease.json');
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(leaseFile)) {
        const raw = fs.readFileSync(leaseFile, 'utf-8');
        const lease = JSON.parse(raw);
        if (lease.status === 'FETCHING' && lease.pid === process.pid) {
          fs.writeFileSync(leaseFile, JSON.stringify({ ...lease, startedAt: Date.now() }), 'utf-8');
          this.startLeaseKeepAlive();
          return;
        }
      }
      fs.writeFileSync(leaseFile, JSON.stringify({ status: 'FETCHING', startedAt: Date.now(), pid: process.pid }), 'utf-8');
      this.startLeaseKeepAlive();
    } catch {}
  }

  /**
   * Releases the distributed refresh lease after completing API quota fetches or auto-switch operations.
   */
  public releaseRefreshLease(): void {
    this.stopLeaseKeepAlive();
    const dir = path.join(os.homedir(), '.antigravity-swap');
    const leaseFile = path.join(dir, '.refresh-lease.json');
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(leaseFile, JSON.stringify({ status: 'IDLE', lastCompletedAt: Date.now(), pid: process.pid }), 'utf-8');
    } catch {}
  }
}
