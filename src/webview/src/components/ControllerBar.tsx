import React, { useState, useRef } from 'react';
import { getVsCodeApi } from '../vscode';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { toast } from 'sonner';
import { Zap, RotateCw, Plus } from 'lucide-react';
import { AutoSwitchTarget } from '../types';
import { cn } from '../lib/utils';
import {
  DEFAULT_LOW_QUOTA_THRESHOLD_PERCENT,
  DEFAULT_AUTO_SWITCH_TARGET,
  GLOBAL_REFRESH_COOLDOWN_MS
} from '../constants';

interface ControllerBarProps {
  autoSwitchEnabled: boolean;
  onToggleAutoSwitch: (enabled: boolean) => void;
  autoSwitchTarget?: AutoSwitchTarget;
  onSelectAutoSwitchTarget?: (target: AutoSwitchTarget) => void;
  autoSwitchThreshold?: number;
  onChangeAutoSwitchThreshold?: (threshold: number) => void;
}

export const ControllerBar: React.FC<ControllerBarProps> = ({
  autoSwitchEnabled,
  onToggleAutoSwitch,
  autoSwitchTarget = DEFAULT_AUTO_SWITCH_TARGET,
  onSelectAutoSwitchTarget,
  autoSwitchThreshold = DEFAULT_LOW_QUOTA_THRESHOLD_PERCENT,
  onChangeAutoSwitchThreshold
}) => {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [thresholdInput, setThresholdInput] = useState<string>(() => String(autoSwitchThreshold ?? DEFAULT_LOW_QUOTA_THRESHOLD_PERCENT));
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastRefreshRef = useRef<number>(0);
  const vscode = getVsCodeApi();

  React.useEffect(() => {
    setThresholdInput(String(autoSwitchThreshold ?? DEFAULT_LOW_QUOTA_THRESHOLD_PERCENT));
  }, [autoSwitchThreshold]);

  React.useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const commitThreshold = (val: string) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const trimmed = val.trim();
    if (trimmed === '') {
      setThresholdInput(String(autoSwitchThreshold ?? DEFAULT_LOW_QUOTA_THRESHOLD_PERCENT));
      return;
    }
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 0) {
      const clamped = Math.max(0, Math.min(100, num));
      setThresholdInput(String(clamped));
      if (clamped !== autoSwitchThreshold) {
        onChangeAutoSwitchThreshold?.(clamped);
      }
    } else {
      setThresholdInput(String(autoSwitchThreshold ?? DEFAULT_LOW_QUOTA_THRESHOLD_PERCENT));
    }
  };

  const handleInputChange = (val: string) => {
    const clean = val.replace(/\D/g, '').slice(0, 3);
    setThresholdInput(clean);

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (clean === '') return;

    const num = parseInt(clean, 10);
    if (!isNaN(num) && num >= 0) {
      const clamped = Math.max(0, Math.min(100, num));
      debounceTimerRef.current = setTimeout(() => {
        if (clamped !== autoSwitchThreshold) {
          onChangeAutoSwitchThreshold?.(clamped);
        }
      }, 500);
    }
  };

  const handleImport = () => {
    vscode.postMessage({ command: 'importCurrentAntigravity' });
  };

  const handleRefresh = () => {
    const now = Date.now();
    const elapsed = now - lastRefreshRef.current;

    if (elapsed < GLOBAL_REFRESH_COOLDOWN_MS) {
      const remSec = Math.ceil((GLOBAL_REFRESH_COOLDOWN_MS - elapsed) / 1000);
      toast.warning(
        `Please wait ${remSec}s before refreshing all accounts again to prevent rate limits.`
      );
      return;
    }

    lastRefreshRef.current = now;
    setIsRefreshing(true);
    vscode.postMessage({ command: 'refreshAll' });
    toast.info('Refreshing quotas for all accounts...');
    setTimeout(() => setIsRefreshing(false), 2500);
  };

  const handleSignIn = () => {
    vscode.postMessage({ command: 'addOAuth' });
  };

  const handleToggle = (checked: boolean) => {
    onToggleAutoSwitch(checked);
    vscode.postMessage({ command: 'setAutoSwitch', enabled: checked });
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 mb-3">
      
      {/* Google Sign In Button */}
      <Button
        onClick={handleSignIn}
        size="sm"
        variant="default"
        title="Add account via Google OAuth sign in"
      >
        <Plus className="w-3.5 h-3.5" />
        <span>Google Sign In</span>
      </Button>
      
      {/* Import Antigravity Button */}
      <Button
        onClick={handleImport}
        size="sm"
        variant="secondary"
        title="Import account from active Antigravity IDE session"
      >
        <Zap className="w-3.5 h-3.5" />
        <span>Import</span>
      </Button>

      {/* Refresh Quotas Button */}
      <Button
        onClick={handleRefresh}
        disabled={isRefreshing}
        size="sm"
        variant="outline"
        title="Refresh quotas for all accounts"
      >
        <RotateCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-primary' : ''}`} />
        <span>{isRefreshing ? 'Refreshing...' : 'Refresh Quotas'}</span>
      </Button>

      {/* Auto-Switch & Target Selector */}
      <div className="inline-flex items-center rounded-md border border-border bg-card/60 p-0.5 text-[11px] font-medium shadow-xs">
        <div
          className="flex items-center gap-1.5 px-2 py-1 cursor-pointer select-none hover:bg-accent/40 rounded transition-colors"
          onClick={() => handleToggle(!autoSwitchEnabled)}
          title="Toggle auto-switch when active account quota is depleted"
        >
          <Switch
            checked={autoSwitchEnabled}
            onCheckedChange={handleToggle}
            aria-label="Toggle Auto-Switch"
          />
          <span className={autoSwitchEnabled ? 'text-foreground font-semibold' : 'text-muted-foreground'}>
            Auto-Switch
          </span>
        </div>

        {autoSwitchEnabled && (
          <div className="flex items-center border-l border-border/80 pl-1.5 ml-0.5 pr-1 gap-1">
            <button
              type="button"
              onClick={() => onSelectAutoSwitchTarget?.('total')}
              className={cn(
                "px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer",
                (autoSwitchTarget || 'total') === 'total'
                  ? "bg-primary text-primary-foreground font-bold shadow-2xs"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}
              title={`Auto-switch when Total Quota <= ${autoSwitchThreshold}%`}
            >
              Total
            </button>
            <button
              type="button"
              onClick={() => onSelectAutoSwitchTarget?.('gemini')}
              className={cn(
                "px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer",
                autoSwitchTarget === 'gemini'
                  ? "bg-sky-500 text-white font-bold shadow-2xs dark:bg-sky-600"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}
              title={`Auto-switch when Gemini Quota <= ${autoSwitchThreshold}% (5h Window for Pro/Ultra, Weekly for Free)`}
            >
              Gemini
            </button>
            <button
              type="button"
              onClick={() => onSelectAutoSwitchTarget?.('claude')}
              className={cn(
                "px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer",
                autoSwitchTarget === 'claude'
                  ? "bg-amber-500 text-white font-bold shadow-2xs dark:bg-amber-600"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}
              title={`Auto-switch when Claude & GPT Quota <= ${autoSwitchThreshold}% (5h Window for Pro/Ultra, Weekly for Free)`}
            >
              Claude
            </button>

            {/* Threshold Percentage Input */}
            <div
              className="flex items-center gap-0.5 border-l border-border/80 pl-1.5 ml-0.5"
              title="Auto-switch when quota drops to or below this percentage"
            >
              <span className="text-[10px] text-muted-foreground select-none font-semibold">≤</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={3}
                value={thresholdInput}
                onChange={(e) => handleInputChange(e.target.value)}
                onBlur={() => commitThreshold(thresholdInput)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    commitThreshold(thresholdInput);
                    (e.target as HTMLInputElement).blur();
                  } else if (e.key === 'Escape') {
                    if (debounceTimerRef.current) {
                      clearTimeout(debounceTimerRef.current);
                      debounceTimerRef.current = null;
                    }
                    setThresholdInput(String(autoSwitchThreshold ?? DEFAULT_LOW_QUOTA_THRESHOLD_PERCENT));
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                className="w-8 h-5 px-1 text-center font-mono text-[10px] font-bold bg-background border border-border/70 rounded focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <span className="text-[10px] text-muted-foreground select-none font-mono font-semibold">%</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
