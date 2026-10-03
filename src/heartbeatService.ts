import * as vscode from 'vscode';
import { AccountManager } from './accountManager';
import { HeartbeatInfo } from './types';

export class HeartbeatService implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private intervalSeconds = 30;
  private isRunning = false;
  private lastTick: string = new Date().toISOString();
  private readonly _onHeartbeat = new vscode.EventEmitter<HeartbeatInfo>();
  public readonly onHeartbeat = this._onHeartbeat.event;

  constructor(private readonly accountManager: AccountManager) {}

  public start(intervalSeconds = 30): void {
    this.intervalSeconds = intervalSeconds;
    this.stop();
    this.isRunning = true;

    // Run first tick immediately after brief startup delay
    setTimeout(() => {
      this.tick();
    }, 2000);

    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalSeconds * 1000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.isRunning = false;
  }

  public async tick(): Promise<void> {
    this.lastTick = new Date().toISOString();
    try {
      await this.accountManager.runHeartbeatTick();
    } catch (err) {
      console.warn('[HeartbeatService] Tick error:', err);
    }

    const active = this.accountManager.getActiveAccount();
    let health: 'healthy' | 'warning' | 'error' = 'healthy';
    if (!active || active.isBanned || active.status === 'auth_failed' || active.status === 'banned') {
      health = 'error';
    } else if (active.status === 'low_balance' || active.averageQuotaPercentage < 15) {
      health = 'warning';
    }

    this._onHeartbeat.fire({
      lastTick: this.lastTick,
      intervalSeconds: this.intervalSeconds,
      isRunning: this.isRunning,
      activeAccountHealth: health
    });
  }

  public getHeartbeatInfo(): HeartbeatInfo {
    const active = this.accountManager.getActiveAccount();
    let health: 'healthy' | 'warning' | 'error' = 'healthy';
    if (!active || active.isBanned || active.status === 'auth_failed' || active.status === 'banned') {
      health = 'error';
    } else if (active.status === 'low_balance' || active.averageQuotaPercentage < 15) {
      health = 'warning';
    }

    return {
      lastTick: this.lastTick,
      intervalSeconds: this.intervalSeconds,
      isRunning: this.isRunning,
      activeAccountHealth: health
    };
  }

  public dispose(): void {
    this.stop();
    this._onHeartbeat.dispose();
  }
}
