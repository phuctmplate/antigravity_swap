import React, { useState, useRef } from 'react';
import { getVsCodeApi } from '../vscode';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { toast } from 'sonner';
import { Zap, RotateCw, Plus } from 'lucide-react';
import { AutoSwitchTarget } from '../types';
import { cn } from '../lib/utils';

interface ControllerBarProps {
  autoSwitchEnabled: boolean;
  onToggleAutoSwitch: (enabled: boolean) => void;
  autoSwitchTarget?: AutoSwitchTarget;
  onSelectAutoSwitchTarget?: (target: AutoSwitchTarget) => void;
}

const GLOBAL_REFRESH_COOLDOWN_MS = 6000;

export const ControllerBar: React.FC<ControllerBarProps> = ({
  autoSwitchEnabled,
  onToggleAutoSwitch,
  autoSwitchTarget = 'total',
  onSelectAutoSwitchTarget
}) => {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const lastRefreshRef = useRef<number>(0);
  const vscode = getVsCodeApi();

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
              title="Auto-switch when Total Quota <= 3%"
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
              title="Auto-switch when Gemini Quota <= 3% (5h Window for Pro/Ultra, Weekly for Free)"
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
              title="Auto-switch when Claude & GPT Quota <= 3% (5h Window for Pro/Ultra, Weekly for Free)"
            >
              Claude
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
