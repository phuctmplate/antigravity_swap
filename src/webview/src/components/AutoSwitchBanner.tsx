import React from 'react';
import { Switch } from './ui/switch';
import { AutoSwitchTarget } from '../types';
import { cn } from '../lib/utils';

interface AutoSwitchBannerProps {
  autoSwitchEnabled: boolean;
  onToggleAutoSwitch: (enabled: boolean) => void;
  target?: AutoSwitchTarget;
  threshold?: number;
}

export const AutoSwitchBanner: React.FC<AutoSwitchBannerProps> = ({
  autoSwitchEnabled,
  onToggleAutoSwitch,
  target = 'gemini',
  threshold = 2
}) => {
  const targetLabel =
    target === 'gemini' ? 'Gemini' : target === 'claude' ? 'Claude & GPT' : 'Total Quota';

  return (
    <div
      className={cn(
        'sticky top-0 z-40 w-full h-8 border-b backdrop-blur-md transition-colors duration-200 select-none',
        'bg-background/85 dark:bg-card/80',
        autoSwitchEnabled
          ? 'border-emerald-500/20 dark:border-emerald-500/30'
          : 'border-border/50'
      )}
    >
      <div className="flex items-center justify-between h-full px-3 max-w-7xl mx-auto w-full gap-2">
        {/* Left: Status indicator & text */}
        <div
          className="flex items-center gap-2 min-w-0 h-full cursor-pointer group"
          onClick={() => onToggleAutoSwitch(!autoSwitchEnabled)}
          title={
            autoSwitchEnabled
              ? 'Auto-Switch is ON. Click to pause.'
              : 'Auto-Switch is OFF. Click to enable.'
          }
        >
          {/* Subtle indicator dot */}
          <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
            {autoSwitchEnabled ? (
              <>
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-50" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.4)]" />
              </>
            ) : (
              <span className="relative inline-flex rounded-full h-2 w-2 bg-muted-foreground/35" />
            )}
          </span>

          <div className="flex items-center gap-1.5 text-xs min-w-0 truncate">
            <span className="text-muted-foreground font-medium">Auto-Switch:</span>
            <span
              className={cn(
                'font-bold uppercase tracking-wider',
                autoSwitchEnabled
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-muted-foreground'
              )}
            >
              {autoSwitchEnabled ? 'ON' : 'OFF'}
            </span>

            <span className="text-[11px] text-muted-foreground/70 truncate hidden sm:inline-block">
              {autoSwitchEnabled
                ? `(when ${targetLabel} ≤ ${threshold}%)`
                : '(paused · manual mode)'}
            </span>
          </div>
        </div>

        {/* Right: Quick action toggle switch */}
        <div className="flex items-center h-full shrink-0">
          <Switch
            checked={autoSwitchEnabled}
            onCheckedChange={onToggleAutoSwitch}
            aria-label="Toggle Auto-Switch"
            title={
              autoSwitchEnabled
                ? 'Auto-Switch is ON. Click to pause.'
                : 'Auto-Switch is OFF. Click to enable.'
            }
            className="cursor-pointer"
          />
        </div>
      </div>
    </div>
  );
};
