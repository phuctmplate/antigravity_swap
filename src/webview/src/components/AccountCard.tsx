import React, { useState, useEffect } from 'react';
import { Account } from '../types';
import { getVsCodeApi } from '../vscode';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Progress, DashedProgress } from './ui/progress';
import { Checkbox } from './ui/checkbox';
import { KeyRound, RotateCw, Trash2, ArrowRightLeft, ShieldAlert, AlertTriangle, Clock, Calendar, Gauge, Zap } from 'lucide-react';
import { quotaFillClass, quotaTextClass, calculateModulatedInstantQuota, parseCountdownFromDescription, MODEL_WEIGHTS, SAFE_WEEKLY_THRESHOLDS } from '../lib/quota';
import { cn } from '../lib/utils';
import { toast } from './ui/sonner';

interface AccountCardProps {
  account: Account;
  isActive: boolean;
  isSelected: boolean;
  isMultiSelectMode?: boolean;
  isChecked?: boolean;
  isRefreshing?: boolean;
  onSelect: (email: string) => void;
  onToggleCheck?: (email: string) => void;
  onDeleteRequest?: (email: string) => void;
  onRefreshRequest?: (email: string) => void;
}

export const AccountCard: React.FC<AccountCardProps> = ({
  account,
  isActive,
  isSelected,
  isMultiSelectMode = false,
  isChecked = false,
  isRefreshing = false,
  onSelect,
  onToggleCheck,
  onDeleteRequest,
  onRefreshRequest
}) => {
  const [isSwitching, setIsSwitching] = useState(false);
  const vscode = getVsCodeApi();

  useEffect(() => {
    setIsSwitching(false);
  }, [isActive, account.lastUsedAt]);

  const isBanned = account.isBanned || account.status === 'banned';
  const isAuthFailed = account.status === 'auth_failed';
  const isFree = !account.tierBadge || account.tierBadge === 'STANDARD FREE';
  const isPro = account.tierBadge === 'PRO' || account.tierBadge === 'AI PREMIUM';
  const isUltra = account.tierBadge === 'ULTRA' || account.tierBadge === 'ENTERPRISE';
  const isProOrAbove = !isFree;

  // Group resolution
  const geminiGroup = account.geminiGroup || account.quotaGroups?.find((g) => g.id === 'gemini' || (g.name.toLowerCase().includes('gemini') && !g.name.toLowerCase().includes('argon')));
  const claudeGptGroup = account.claudeGptGroup || account.quotaGroups?.find((g) => g.id === 'claude_gpt' || g.name.toLowerCase().includes('claude') || g.name.toLowerCase().includes('gpt'));
  const argonGroup = isPro ? (account.argonGroup || account.quotaGroups?.find((g) => g.id === 'argon' || g.name.toLowerCase().includes('argon'))) : undefined;

  const quotas = account.quotas || [];
  // 5h quotas only exist for paid tiers (Free tier strictly has no 5h bucket)
  const fiveHourQuotas = isFree ? [] : quotas.filter((q) => q.windowType === '5h' && !q.disabled && q.percentage >= 0);
  const weeklyQuotas = quotas.filter((q) => q.windowType === 'weekly' && !q.disabled && q.percentage >= 0);

  // Resolve bucket with real-time expiration guard: Only auto-expire to 100% if data is stale (> 15m)
  const resolveBucket = (b?: any) => {
    if (!b || b.disabled) return undefined;
    const lastRefreshTime = account.lastRefreshedAt ? new Date(account.lastRefreshedAt).getTime() : 0;
    const isDataStale = (Date.now() - lastRefreshTime) > 15 * 60 * 1000;
    const isExpired = isDataStale && b.resetTime && new Date(b.resetTime).getTime() <= Date.now();
    if (isExpired) {
      return {
        ...b,
        remainingFraction: 1.0,
        percentage: 100,
        resetTime: undefined,
        resetCountdown: b.window === 'weekly' ? '6d 23h' : 'Ready'
      };
    }
    return b;
  };

  // Gemini buckets: Free tier strictly has no 5h bucket (exclude Argon on Pro)
  const isArgonQuota = (q: any) => (q.groupName || '').toLowerCase().includes('argon') || (q.id + ' ' + q.displayName).toLowerCase().includes('argon');
  const gemini5h = isFree
    ? undefined
    : resolveBucket(
        geminiGroup?.fiveHour ||
        fiveHourQuotas.find((q) => (!isPro || !isArgonQuota(q)) && (q.displayName.toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('flash')))
      );
  const geminiWeekly = resolveBucket(
    geminiGroup?.weekly ||
    weeklyQuotas.find((q) => (!isPro || !isArgonQuota(q)) && (q.displayName.toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('pro')))
  );

  // Claude & GPT buckets: Free tier strictly has no 5h bucket
  const claude5h = isFree ? undefined : resolveBucket(claudeGptGroup?.fiveHour || fiveHourQuotas.find((q) => q.displayName.toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('gpt')));
  const claudeWeekly = resolveBucket(claudeGptGroup?.weekly || weeklyQuotas.find((q) => q.displayName.toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('gpt')));

  // Argon bucket: Dedicated weekly-only bucket on Pro plan (merged into Gemini bucket on Ultra)
  const argonWeekly = isPro
    ? resolveBucket(argonGroup?.weekly || argonGroup?.buckets?.[0] || weeklyQuotas.find((q) => isArgonQuota(q)))
    : undefined;

  // Validity checks for buckets
  const validGemini5h = gemini5h && !gemini5h.disabled && gemini5h.percentage >= 0;
  const validGeminiWk = geminiWeekly && !geminiWeekly.disabled && geminiWeekly.percentage >= 0;
  const validClaude5h = claude5h && !claude5h.disabled && claude5h.percentage >= 0;
  const validClaudeWk = claudeWeekly && !claudeWeekly.disabled && claudeWeekly.percentage >= 0;
  const validArgonWk = argonWeekly && !argonWeekly.disabled && argonWeekly.percentage >= 0;

  // Instant quota calculations
  let geminiInstant: number | undefined;
  if (isFree) {
    if (validGeminiWk) {
      geminiInstant = geminiWeekly.percentage;
    } else if (geminiGroup?.buckets?.[0]?.percentage !== undefined && geminiGroup.buckets[0].percentage >= 0) {
      geminiInstant = geminiGroup.buckets[0].percentage;
    }
  } else {
    if (validGemini5h && validGeminiWk) {
      geminiInstant = calculateModulatedInstantQuota(gemini5h.percentage, geminiWeekly.percentage, SAFE_WEEKLY_THRESHOLDS.GEMINI);
    } else if (validGemini5h) {
      geminiInstant = gemini5h.percentage;
    } else if (validGeminiWk) {
      geminiInstant = geminiWeekly.percentage;
    } else if (geminiGroup?.buckets?.[0]?.percentage !== undefined && geminiGroup.buckets[0].percentage >= 0) {
      geminiInstant = geminiGroup.buckets[0].percentage;
    }
  }

  let claudeInstant: number | undefined;
  if (isFree) {
    if (validClaudeWk) {
      claudeInstant = claudeWeekly.percentage;
    } else if (claudeGptGroup?.buckets?.[0]?.percentage !== undefined && claudeGptGroup.buckets[0].percentage >= 0) {
      claudeInstant = claudeGptGroup.buckets[0].percentage;
    }
  } else {
    if (validClaude5h && validClaudeWk) {
      claudeInstant = calculateModulatedInstantQuota(claude5h.percentage, claudeWeekly.percentage, SAFE_WEEKLY_THRESHOLDS.CLAUDE_GPT);
    } else if (validClaude5h) {
      claudeInstant = claude5h.percentage;
    } else if (validClaudeWk) {
      claudeInstant = claudeWeekly.percentage;
    } else if (claudeGptGroup?.buckets?.[0]?.percentage !== undefined && claudeGptGroup.buckets[0].percentage >= 0) {
      claudeInstant = claudeGptGroup.buckets[0].percentage;
    }
  }


  // Account Instant Quota: combines available models without dragging missing models down to 0
  let accountInstant: number | undefined;
  if (geminiInstant != null && claudeInstant != null) {
    accountInstant = Math.round((geminiInstant * MODEL_WEIGHTS.GEMINI) + (claudeInstant * MODEL_WEIGHTS.CLAUDE));
  } else if (geminiInstant != null) {
    accountInstant = geminiInstant;
  } else if (claudeInstant != null) {
    accountInstant = claudeInstant;
  } else {
    // Only fall back to account-level aggregates if present
    if (isFree) {
      accountInstant = account.weeklyQuotaPercentage ?? account.averageQuotaPercentage;
    } else {
      const p5h = account.fiveHourQuotaPercentage;
      const pWk = account.weeklyQuotaPercentage ?? account.averageQuotaPercentage;
      if (p5h !== undefined && pWk !== undefined) {
        accountInstant = calculateModulatedInstantQuota(p5h, pWk, SAFE_WEEKLY_THRESHOLDS.DEFAULT);
      } else if (p5h !== undefined) {
        accountInstant = p5h;
      } else if (pWk !== undefined) {
        accountInstant = pWk;
      }
    }
  }

  // Account Total Quota
  let accountTotal: number | undefined = account.averageQuotaPercentage ?? account.weeklyQuotaPercentage;
  if (accountTotal === undefined) {
    if (validGeminiWk && validClaudeWk) {
      accountTotal = Math.round((geminiWeekly.percentage * MODEL_WEIGHTS.GEMINI) + (claudeWeekly.percentage * MODEL_WEIGHTS.CLAUDE));
    } else if (validGeminiWk) {
      accountTotal = geminiWeekly.percentage;
    } else if (validClaudeWk) {
      accountTotal = claudeWeekly.percentage;
    }
  }

  const getFillClass = quotaFillClass;
  const getTextColor = quotaTextClass;

  const getCountdown = (b?: { resetCountdown?: string; description?: string; window?: string }) => {
    if (!b) return undefined;
    const cd = b.resetCountdown || parseCountdownFromDescription(b.description);
    if (!cd) {
      if (b.window === 'weekly') return '6d 23h';
      return undefined;
    }
    // Physical safeguard: A 5h rolling window by definition cannot reset in days
    if (b.window === '5h' && /\b\d+\s*d\b/i.test(cd)) {
      return undefined;
    }
    // Physical safeguard: A weekly window countdown cannot be hours/minutes if derived from description
    if (b.window === 'weekly' && !b.resetCountdown && !/\b\d+\s*d\b/i.test(cd)) {
      return '6d 23h';
    }
    if (b.window === 'weekly' && cd.toLowerCase().includes('ready')) {
      return '6d 23h';
    }
    return cd;
  };

  // Short status note for a bucket, derived from the API semantics.
  const bucketNote = (b: { disabled?: boolean; notStarted?: boolean; resetCountdown?: string; description?: string; window?: string }) => {
    const cd = getCountdown(b);
    if (!cd) return '';
    if (b.window === 'weekly' && cd.toLowerCase().includes('ready')) {
      return '• resets 6d 23h';
    }
    return cd.toLowerCase().includes('ready') ? '• Ready' : `• resets ${cd}`;
  };

  const handleCardClick = () => {
    if (isMultiSelectMode) {
      onToggleCheck?.(account.email);
    } else {
      onSelect(account.email);
    }
  };

  const handleSwitch = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsSwitching(true);
    toast.info(`Switching to ${account.email}...`);
    vscode.postMessage({ command: 'switchAccount', email: account.email, isManual: true });
    setTimeout(() => {
      setIsSwitching(false);
    }, 4000);
  };

  const handleRelogin = (e: React.MouseEvent) => {
    e.stopPropagation();
    vscode.postMessage({ command: 'relogin', email: account.email });
  };

  const handleRefresh = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onRefreshRequest) {
      onRefreshRequest(account.email);
    } else {
      toast.info(`Refreshing quota for ${account.email}...`);
      vscode.postMessage({ command: 'refreshAccount', email: account.email });
    }
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDeleteRequest) {
      onDeleteRequest(account.email);
    } else {
      vscode.postMessage({ command: 'removeAccount', email: account.email });
    }
  };

  // Dynamic state classes based on Multi-Select / Active / Selected hierarchy
  let cardClasses = 'relative flex flex-col transition-all duration-200 cursor-pointer overflow-hidden ';
  if (isMultiSelectMode && isChecked) {
    cardClasses += isActive
      ? 'border-primary ring-2 ring-primary/80 bg-primary/[0.08] dark:bg-primary/20 shadow-md'
      : 'border-foreground/35 ring-2 ring-foreground/20 bg-accent/70 shadow-md';
  } else if (isBanned) {
    cardClasses += isSelected
      ? 'border-destructive/80 bg-destructive/15 shadow-md ring-1 ring-destructive/40'
      : 'border-destructive/40 bg-destructive/10 hover:border-destructive/60 opacity-80';
  } else if (isAuthFailed) {
    cardClasses += isSelected
      ? 'border-amber-500/80 bg-amber-500/15 shadow-md ring-1 ring-amber-500/40'
      : 'border-amber-500/40 bg-amber-500/10 hover:border-amber-500/60 opacity-80';
  } else if (isActive && isSelected) {
    cardClasses += 'border-primary/80 bg-primary/[0.08] dark:bg-primary/20 shadow-md shadow-primary/10 ring-1 ring-primary/40 hover:bg-primary/[0.12] dark:hover:bg-primary/25';
  } else if (isActive && !isSelected) {
    cardClasses += 'border-primary/40 bg-primary/[0.04] dark:bg-primary/10 hover:bg-primary/[0.07] dark:hover:bg-primary/15';
  } else if (!isActive && isSelected) {
    cardClasses += 'border-foreground/25 bg-accent/50 ring-1 ring-foreground/15 shadow-sm hover:bg-accent/65';
  } else {
    cardClasses += 'border-border/80 bg-card/70 hover:bg-accent/30 hover:border-border';
  }

  const avatarChar = (account.name ? account.name[0] : account.email[0]).toUpperCase();

  return (
    <Card
      onClick={handleCardClick}
      className={cardClasses}
    >
      {/* Top-Left Checkbox in Multi-Select Mode */}
      {isMultiSelectMode && (
        <div
          className="absolute top-2.5 left-2.5 z-10 flex items-center justify-center cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCheck?.(account.email);
          }}
          title={isChecked ? 'Deselect account' : 'Select account'}
        >
          <Checkbox
            checked={isChecked}
            onCheckedChange={() => onToggleCheck?.(account.email)}
            aria-label={`Select account ${account.name || account.email}`}
            className="bg-card/90 shadow-xs border-border/80 hover:border-primary"
          />
        </div>
      )}

      {/* Active Left Vertical Accent Bar (hidden when multi-select to avoid clutter) */}
      {isActive && !isMultiSelectMode && (
        <div className="absolute left-0 top-0 bottom-0 w-0.75 bg-linear-to-b from-primary to-indigo-500" />
      )}

      <CardContent className="flex flex-col flex-1 p-2.5">
        {/* Card Header: Avatar, Info, and Overall Quota Percentage */}
        <div className={cn("flex items-start justify-between gap-2 mb-2", isMultiSelectMode && "pl-6")}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {/* Avatar: Pro+ accounts feature a mathematically concentric SVG vector ring */}
            <div className="relative flex h-[36px] w-[36px] shrink-0 items-center justify-center">
              {isProOrAbove && (
                <svg
                  className="absolute inset-0 h-[36px] w-[36px] pointer-events-none"
                  viewBox="0 0 36 36"
                  fill="none"
                  aria-hidden="true"
                  shapeRendering="geometricPrecision"
                >
                  <defs>
                    <linearGradient
                      id={`pro-avatar-ring-${account.id || account.email.replace(/[^a-zA-Z0-9]/g, '_')}`}
                      x1="0%"
                      y1="100%"
                      x2="100%"
                      y2="0%"
                    >
                      <stop offset="0%" stopColor="#3b82f6" />
                      <stop offset="50%" stopColor="#6366f1" />
                      <stop offset="100%" stopColor="#a855f7" />
                    </linearGradient>
                  </defs>
                  <circle
                    cx="18"
                    cy="18"
                    r="16.5"
                    stroke={`url(#pro-avatar-ring-${account.id || account.email.replace(/[^a-zA-Z0-9]/g, '_')})`}
                    strokeWidth="2"
                  />
                </svg>
              )}
              <div
                className={cn(
                  "relative flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full overflow-hidden text-xs font-bold",
                  isProOrAbove
                    ? "bg-card text-foreground"
                    : "border border-border/80 bg-secondary text-muted-foreground shadow-2xs"
                )}
              >
                {account.avatarUrl ? (
                  <img src={account.avatarUrl} alt={account.name || ''} className="h-full w-full object-cover" />
                ) : isProOrAbove ? (
                  <span className="flex h-full w-full items-center justify-center bg-linear-to-br from-blue-500 via-indigo-500 to-purple-500 text-white font-bold">
                    {avatarChar}
                  </span>
                ) : (
                  avatarChar
                )}
              </div>
            </div>

            <div className="flex flex-1 flex-col min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-bold text-xs text-foreground truncate max-w-30">
                  {account.name || account.email}
                </span>

                {/* Status & Tier Badges */}
                {account.tierBadge === 'ENTERPRISE' && (
                  <Badge variant="success" className="text-[8px] px-1 py-0 font-bold">
                    ENTERPRISE
                  </Badge>
                )}
                {account.tierBadge === 'ULTRA' && (
                  <Badge variant="info" className="text-[8px] px-1 py-0 font-bold bg-fuchsia-100 text-fuchsia-800 border-fuchsia-300 dark:bg-purple-500/20 dark:text-purple-300 dark:border-purple-500/30">
                    ULTRA
                  </Badge>
                )}
                {account.tierBadge === 'AI PREMIUM' && (
                  <Badge variant="info" className="text-[8px] px-1 py-0 font-bold">
                    AI PREMIUM
                  </Badge>
                )}
                {account.tierBadge === 'PRO' && (
                  <Badge variant="pro" className="text-[8px] px-1 py-0 font-bold">
                    PRO
                  </Badge>
                )}
                {isFree && (
                  <Badge variant="outline" className="text-[8px] px-1 py-0 font-bold text-muted-foreground border-border/70 bg-muted/30">
                    FREE
                  </Badge>
                )}
                {isActive && (
                  <Badge variant="default" className="text-[8px] px-1 py-0 font-bold">
                    ACTIVE
                  </Badge>
                )}
                {isBanned && (
                  <Badge variant="destructive" className="text-[8px] px-1 py-0 gap-0.5 font-bold">
                    <ShieldAlert className="w-2.5 h-2.5" />
                    <span>BANNED</span>
                  </Badge>
                )}
                {isAuthFailed && (
                  <Badge variant="warning" className="text-[8px] px-1 py-0 gap-0.5 font-bold">
                    <AlertTriangle className="w-2.5 h-2.5" />
                    <span>AUTH FAILED</span>
                  </Badge>
                )}
              </div>
              <div className="text-[10px] text-muted-foreground truncate">{account.email}</div>
              {(() => {
                const isGeminiHealthy = (geminiInstant != null && geminiInstant > 0) || (geminiWeekly?.percentage != null && geminiWeekly.percentage > 0);
                const isClaudeHealthy = (claudeInstant != null && claudeInstant > 0) || (claudeWeekly?.percentage != null && claudeWeekly.percentage > 0);
                const isStaleDepletionMsg = (isGeminiHealthy && isClaudeHealthy) && (account.statusMessage || '').includes('depleted');
                if (account.statusMessage && !isStaleDepletionMsg) {
                  return <div className="text-[10px] text-amber-400 mt-0.5">{account.statusMessage}</div>;
                }
                return null;
              })()}
            </div>
          </div>
        </div>

        {/* Quota Section: Separate Gemini, Argon (on Pro), and Claude & GPT */}
        <div className="mt-1 mb-2 flex-1 flex flex-col gap-2">
          {isBanned ? (
            <div className="text-[10px] font-medium text-destructive py-1 flex items-center gap-1">
              <ShieldAlert className="w-3 h-3 text-destructive shrink-0" />
              <span>Account suspended by Google Terms of Service.</span>
            </div>
          ) : isAuthFailed ? (
            <div className="text-[10px] font-medium text-amber-400 py-1 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
              <span>Authentication required. Click Re-login to authenticate.</span>
            </div>
          ) : (
            <>
              {/* Group 1: Gemini Models (merged with Argon on Ultra) */}
              <div className="flex flex-col gap-1 rounded-md bg-accent/25 p-1.5 border border-border/40">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="font-semibold text-foreground flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                    Gemini Models
                  </span>
                  {isFree && (
                    <span className="text-[9px] text-muted-foreground font-medium">Free Tier</span>
                  )}
                  {isUltra && (
                    <span className="text-[9px] text-purple-400/90 font-medium" title="On Ultra plan, Gemini 4 Argon is merged into the Gemini Models bucket">
                      incl. Argon
                    </span>
                  )}
                </div>

                {/* Gemini Instant Quota Slot (Always rendered) */}
                <div
                  className="flex flex-col gap-0.5 cursor-help"
                  title={geminiInstant != null ? `Gemini Instant Quota (${geminiInstant}%): Usable quota available right now, calculated from the 5h rolling window modulated by weekly capacity.` : 'Gemini Instant Quota: No data'}
                >
                  <div className="flex justify-between items-center text-[9px]">
                    <span className="flex items-center gap-1 min-w-0">
                      <Zap className={cn("w-2.5 h-2.5 shrink-0", geminiInstant != null ? "text-amber-400" : "text-muted-foreground/40")} />
                      <span className={cn("font-medium", geminiInstant != null ? "text-foreground/90" : "text-muted-foreground/50")}>Instant</span>
                    </span>
                    <span className={cn("font-bold font-mono ml-1 shrink-0", geminiInstant != null ? getTextColor(geminiInstant) : "text-muted-foreground")}>
                      {geminiInstant != null ? `${geminiInstant}%` : '-%'}
                    </span>
                  </div>
                  <Progress
                    value={geminiInstant ?? 0}
                    indicatorClassName={geminiInstant != null ? getFillClass(geminiInstant) : "bg-transparent"}
                    className="h-1.5 w-full"
                  />
                </div>

                {/* Gemini Sub-Windows Container (Always rendered) */}
                <div className="flex flex-col gap-1.5 pt-1.5 border-t border-border/30 mt-0.5">
                  {/* Gemini 5h Window Slot (Only rendered for non-Free tiers) */}
                  {!isFree && (
                    <div className="flex flex-col gap-0.5">
                      <div
                        className="flex items-center justify-between text-[9px] text-muted-foreground hover:text-foreground/90 transition-colors"
                        title={validGemini5h ? `5h: ${gemini5h.disabled ? 'N/A' : gemini5h.percentage + '%'} ${bucketNote(gemini5h)}` : '5h rolling limit: No data'}
                      >
                        <span className="flex items-center gap-1 min-w-0">
                          <Clock className={cn("w-2.5 h-2.5 shrink-0", validGemini5h ? "text-sky-400" : "text-muted-foreground/40")} />
                          <span className={cn("font-medium", validGemini5h ? "text-foreground/80" : "text-muted-foreground/50")}>5h</span>
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0 font-mono text-[9px]">
                          {validGemini5h && getCountdown(gemini5h) && (
                            <span className="text-muted-foreground/80 font-normal">
                              {getCountdown(gemini5h)!.toLowerCase().includes('ready') ? 'Ready' : `resets ${getCountdown(gemini5h)}`}
                            </span>
                          )}
                          {validGemini5h && getCountdown(gemini5h) && <span className="text-muted-foreground/50 font-normal">•</span>}
                          <span className={cn("font-bold", validGemini5h ? (gemini5h.disabled ? "text-muted-foreground" : getTextColor(gemini5h.percentage)) : "text-muted-foreground")}>
                            {validGemini5h ? (gemini5h.disabled ? 'N/A' : `${gemini5h.percentage}%`) : '-%'}
                          </span>
                        </div>
                      </div>
                      <DashedProgress
                        value={validGemini5h ? gemini5h.percentage : 0}
                        disabled={!validGemini5h || gemini5h.disabled}
                        indicatorClassName={validGemini5h ? (gemini5h.disabled ? "bg-muted" : getFillClass(gemini5h.percentage)) : "bg-transparent"}
                        className="h-1.5 w-full"
                      />
                    </div>
                  )}

                  {/* Gemini Weekly Window Slot (Always rendered for all tiers) */}
                  <div className="flex flex-col gap-0.5">
                    <div
                      className="flex items-center justify-between text-[9px] text-muted-foreground hover:text-foreground/90 transition-colors"
                      title={validGeminiWk ? `Weekly: ${geminiWeekly.percentage}% ${bucketNote(geminiWeekly)}` : 'Weekly quota: No data'}
                    >
                      <span className="flex items-center gap-1 min-w-0">
                        <Calendar className={cn("w-2.5 h-2.5 shrink-0", validGeminiWk ? "text-purple-400" : "text-muted-foreground/40")} />
                        <span className={cn("font-medium", validGeminiWk ? "text-foreground/80" : "text-muted-foreground/50")}>Weekly</span>
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0 font-mono text-[9px]">
                        {validGeminiWk && getCountdown(geminiWeekly) && (
                          <span className="text-muted-foreground/80 font-normal">
                            {getCountdown(geminiWeekly)!.toLowerCase().includes('ready') ? 'resets 6d 23h' : `resets ${getCountdown(geminiWeekly)}`}
                          </span>
                        )}
                        {validGeminiWk && getCountdown(geminiWeekly) && <span className="text-muted-foreground/50 font-normal">•</span>}
                        <span className={cn("font-bold", validGeminiWk ? getTextColor(geminiWeekly.percentage) : "text-muted-foreground")}>
                          {validGeminiWk ? `${geminiWeekly.percentage}%` : '-%'}
                        </span>
                      </div>
                    </div>
                    <DashedProgress
                      value={validGeminiWk ? geminiWeekly.percentage : 0}
                      disabled={!validGeminiWk || geminiWeekly.disabled}
                      indicatorClassName={validGeminiWk ? getFillClass(geminiWeekly.percentage) : "bg-transparent"}
                      className="h-1.5 w-full"
                    />
                  </div>
                </div>
              </div>

              {/* Group 2: Claude & GPT Models */}
              <div className="flex flex-col gap-1 rounded-md bg-accent/25 p-1.5 border border-border/40">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="font-semibold text-foreground flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    Claude & GPT
                  </span>
                  {isFree && (
                    <span className="text-[9px] text-muted-foreground font-medium">Free Tier</span>
                  )}
                </div>

                {/* Claude & GPT Instant Quota Slot (Always rendered) */}
                <div
                  className="flex flex-col gap-0.5 cursor-help"
                  title={claudeInstant != null ? `Claude & GPT Instant Quota (${claudeInstant}%): Usable quota available right now, calculated from the 5h rolling window modulated by weekly capacity.` : 'Claude & GPT Instant Quota: No data'}
                >
                  <div className="flex justify-between items-center text-[9px]">
                    <span className="flex items-center gap-1 min-w-0">
                      <Zap className={cn("w-2.5 h-2.5 shrink-0", claudeInstant != null ? "text-amber-400" : "text-muted-foreground/40")} />
                      <span className={cn("font-medium", claudeInstant != null ? "text-foreground/90" : "text-muted-foreground/50")}>Instant</span>
                    </span>
                    <span className={cn("font-bold font-mono ml-1 shrink-0", claudeInstant != null ? getTextColor(claudeInstant) : "text-muted-foreground")}>
                      {claudeInstant != null ? `${claudeInstant}%` : '-%'}
                    </span>
                  </div>
                  <Progress
                    value={claudeInstant ?? 0}
                    indicatorClassName={claudeInstant != null ? getFillClass(claudeInstant) : "bg-transparent"}
                    className="h-1.5 w-full"
                  />
                </div>

                {/* Claude Sub-Windows Container (Always rendered) */}
                <div className="flex flex-col gap-1.5 pt-1.5 border-t border-border/30 mt-0.5">
                  {/* Claude 5h Window Slot (Only rendered for non-Free tiers) */}
                  {!isFree && (
                    <div className="flex flex-col gap-0.5">
                      <div
                        className="flex items-center justify-between text-[9px] text-muted-foreground hover:text-foreground/90 transition-colors"
                        title={validClaude5h ? `5h: ${claude5h.disabled ? 'N/A' : claude5h.percentage + '%'} ${bucketNote(claude5h)}` : '5h rolling limit: No data'}
                      >
                        <span className="flex items-center gap-1 min-w-0">
                          <Clock className={cn("w-2.5 h-2.5 shrink-0", validClaude5h ? "text-sky-400" : "text-muted-foreground/40")} />
                          <span className={cn("font-medium", validClaude5h ? "text-foreground/80" : "text-muted-foreground/50")}>5h</span>
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0 font-mono text-[9px]">
                          {validClaude5h && getCountdown(claude5h) && (
                            <span className={cn("font-normal", claude5h.disabled ? "text-amber-400/90" : "text-muted-foreground/80")}>
                              {getCountdown(claude5h)!.toLowerCase().includes('ready') ? 'Ready' : `resets ${getCountdown(claude5h)}`}
                            </span>
                          )}
                          {validClaude5h && getCountdown(claude5h) && <span className="text-muted-foreground/50 font-normal">•</span>}
                          <span className={cn("font-bold", validClaude5h ? (claude5h.disabled ? "text-muted-foreground" : getTextColor(claude5h.percentage)) : "text-muted-foreground")}>
                            {validClaude5h ? (claude5h.disabled ? 'N/A' : `${claude5h.percentage}%`) : '-%'}
                          </span>
                        </div>
                      </div>
                      <DashedProgress
                        value={validClaude5h ? claude5h.percentage : 0}
                        disabled={!validClaude5h || claude5h.disabled}
                        indicatorClassName={validClaude5h ? (claude5h.disabled ? "bg-muted" : getFillClass(claude5h.percentage)) : "bg-transparent"}
                        className="h-1.5 w-full"
                      />
                    </div>
                  )}

                  {/* Claude Weekly Window Slot (Always rendered for all tiers) */}
                  <div className="flex flex-col gap-0.5">
                    <div
                      className="flex items-center justify-between text-[9px] text-muted-foreground hover:text-foreground/90 transition-colors"
                      title={validClaudeWk ? `Weekly: ${claudeWeekly.percentage}% ${bucketNote(claudeWeekly)}` : 'Weekly quota: No data'}
                    >
                      <span className="flex items-center gap-1 min-w-0">
                        <Calendar className={cn("w-2.5 h-2.5 shrink-0", validClaudeWk ? "text-purple-400" : "text-muted-foreground/40")} />
                        <span className={cn("font-medium", validClaudeWk ? "text-foreground/80" : "text-muted-foreground/50")}>Weekly</span>
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0 font-mono text-[9px]">
                        {validClaudeWk && getCountdown(claudeWeekly) && (
                          <span className="text-muted-foreground/80 font-normal">
                            {getCountdown(claudeWeekly)!.toLowerCase().includes('ready') ? 'resets 6d 23h' : `resets ${getCountdown(claudeWeekly)}`}
                          </span>
                        )}
                        {validClaudeWk && getCountdown(claudeWeekly) && <span className="text-muted-foreground/50 font-normal">•</span>}
                        <span className={cn("font-bold", validClaudeWk ? getTextColor(claudeWeekly.percentage) : "text-muted-foreground")}>
                          {validClaudeWk ? `${claudeWeekly.percentage}%` : '-%'}
                        </span>
                      </div>
                    </div>
                    <DashedProgress
                      value={validClaudeWk ? claudeWeekly.percentage : 0}
                      disabled={!validClaudeWk || claudeWeekly.disabled}
                      indicatorClassName={validClaudeWk ? getFillClass(claudeWeekly.percentage) : "bg-transparent"}
                      className="h-1.5 w-full"
                    />
                  </div>
                </div>
              </div>

              {/* Group 3 (Pro Plan Only): Argon Models - only rendered if the account's Pro plan actually includes Argon */}
              {Boolean(isPro && argonWeekly && validArgonWk) && (
                <div className="flex flex-col gap-1 rounded-md bg-accent/25 p-1.5 border border-border/40">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="font-semibold text-foreground flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-violet-500" />
                      Argon Models
                    </span>
                  </div>

                  {/* Argon Weekly Window Slot */}
                  <div className="flex flex-col gap-0.5">
                    <div
                      className="flex items-center justify-between text-[9px] text-muted-foreground hover:text-foreground/90 transition-colors"
                      title={validArgonWk ? `Argon Weekly: ${argonWeekly.percentage}% ${bucketNote(argonWeekly)}` : 'Argon Weekly limit: No data'}
                    >
                      <span className="flex items-center gap-1 min-w-0">
                        <Calendar className={cn("w-2.5 h-2.5 shrink-0", validArgonWk ? "text-violet-400" : "text-muted-foreground/40")} />
                        <span className={cn("font-medium", validArgonWk ? "text-foreground/80" : "text-muted-foreground/50")}>Weekly</span>
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0 font-mono text-[9px]">
                        {validArgonWk && getCountdown(argonWeekly) && (
                          <span className="text-muted-foreground/80 font-normal">
                            {getCountdown(argonWeekly)!.toLowerCase().includes('ready') ? 'resets 6d 23h' : `resets ${getCountdown(argonWeekly)}`}
                          </span>
                        )}
                        {validArgonWk && getCountdown(argonWeekly) && <span className="text-muted-foreground/50 font-normal">•</span>}
                        <span className={cn("font-bold", validArgonWk ? getTextColor(argonWeekly.percentage) : "text-muted-foreground")}>
                          {validArgonWk ? `${argonWeekly.percentage}%` : '-%'}
                        </span>
                      </div>
                    </div>
                    <DashedProgress
                      value={validArgonWk ? argonWeekly.percentage : 0}
                      disabled={!validArgonWk || argonWeekly.disabled}
                      indicatorClassName={validArgonWk ? getFillClass(argonWeekly.percentage) : "bg-transparent"}
                      className="h-1.5 w-full"
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Total & Instant Account Quota Progress Bars */}
        {!isBanned && !isAuthFailed && (
          <div className="flex flex-col gap-1.5 rounded-md bg-accent/15 p-1.5 border border-border/30 mb-1.5">
            {/* Account Instant Quota */}
            <div
              className="flex flex-col gap-0.5 cursor-help"
              title={`Account Instant Quota (${accountInstant != null ? `${accountInstant}%` : '-%'}): Effective usable quota available right now across all models for this account.`}
            >
              <div className="flex justify-between items-center text-[10px]">
                <span className="flex items-center gap-1 font-medium">
                  <Zap className="w-3 h-3 text-amber-400 shrink-0" />
                  <span className="text-foreground/90 font-semibold">Account Instant Quota</span>
                </span>
                <span className={cn("font-bold font-mono", accountInstant != null ? getTextColor(accountInstant) : "text-muted-foreground")}>
                  {accountInstant != null ? `${accountInstant}%` : '-%'}
                </span>
              </div>
              <Progress
                value={accountInstant != null ? accountInstant : 0}
                indicatorClassName={accountInstant != null ? getFillClass(accountInstant) : "bg-transparent"}
                className="h-1.5 w-full"
              />
            </div>

            {/* Account Total Quota */}
            <div
              className="flex flex-col gap-0.5 cursor-help"
              title={`Account Total Quota (${accountTotal != null ? `${accountTotal}%` : '-%'}): Total weekly quota capacity for this account.`}
            >
              <div className="flex justify-between items-center text-[10px]">
                <span className="flex items-center gap-1 font-medium">
                  <Gauge className="w-3 h-3 text-muted-foreground/80 shrink-0" />
                  <span className="text-foreground/90 font-semibold">Account Total Quota</span>
                </span>
                <span className={cn("font-bold font-mono", accountTotal != null ? getTextColor(accountTotal) : "text-muted-foreground")}>
                  {accountTotal != null ? `${accountTotal}%` : '-%'}
                </span>
              </div>
              <Progress
                value={accountTotal != null ? accountTotal : 0}
                indicatorClassName={accountTotal != null ? getFillClass(accountTotal) : "bg-transparent"}
                className="h-1.5 w-full"
              />
            </div>
          </div>
        )}

        {/* Card Action Buttons */}
        <div className="flex items-center justify-between gap-1 mt-auto pt-1.5 border-t border-border/60">
          <span className="text-[10px] text-muted-foreground font-medium">
            {account.accountType || 'Standard Free'}
          </span>

          <div className="flex items-center gap-1">
            {isAuthFailed && (
              <Button
                onClick={handleRelogin}
                size="xs"
                variant="outline"
                title="Re-login account to update credentials"
                className="bg-amber-500/15 text-amber-300 border-amber-500/50 hover:bg-amber-500/25 gap-1 font-semibold"
              >
                <KeyRound className="w-3 h-3 text-amber-400" />
                <span>Re-login</span>
              </Button>
            )}

            {!isAuthFailed && !isBanned && (
              <Button
                onClick={handleRefresh}
                disabled={isRefreshing}
                size="iconXs"
                variant="outline"
                title="Refresh quota"
              >
                <RotateCw className={cn("w-3 h-3", isRefreshing && "animate-spin text-primary")} />
              </Button>
            )}

            <Button
              onClick={handleRemove}
              size="iconXs"
              variant="outline"
              title="Remove account"
              className="hover:text-rose-400 hover:border-rose-500/50"
            >
              <Trash2 className="w-3 h-3" />
            </Button>

            {!isActive && !isBanned && !isAuthFailed && !isMultiSelectMode && (
              <Button
                onClick={handleSwitch}
                disabled={isSwitching}
                size="xs"
                variant="default"
                className="min-w-14"
              >
                {isSwitching ? (
                  <RotateCw className="w-3 h-3 animate-spin" />
                ) : (
                  <>
                    <ArrowRightLeft className="w-3 h-3" />
                    <span>Switch</span>
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
