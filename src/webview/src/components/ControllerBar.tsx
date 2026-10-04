import React, { useState, useRef } from 'react';
import { getVsCodeApi } from '../vscode';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { toast } from 'sonner';
import { Zap, RotateCw, Plus, ExternalLink } from 'lucide-react';

interface ControllerBarProps {
  autoSwitchEnabled: boolean;
  onToggleAutoSwitch: (enabled: boolean) => void;
}

const GLOBAL_REFRESH_COOLDOWN_MS = 6000;

export const ControllerBar: React.FC<ControllerBarProps> = ({
  autoSwitchEnabled,
  onToggleAutoSwitch
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

      {/* Auto-Switch shadcn Switch */}
      <div
        className="inline-flex items-center gap-2 rounded-md border border-border bg-card/60 px-2.5 py-1 text-[11px] font-medium text-foreground shadow-xs cursor-pointer select-none hover:bg-accent/40 transition-colors"
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
    </div>
  );
};
