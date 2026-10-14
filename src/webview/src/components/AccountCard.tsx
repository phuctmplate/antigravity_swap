import React, { useState } from 'react';
import { Account } from '../types';
import { getVsCodeApi } from '../vscode';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Progress, DashedProgress } from './ui/progress';
import { Checkbox } from './ui/checkbox';
import { KeyRound, RotateCw, Trash2, ArrowRightLeft, ShieldAlert, AlertTriangle, Clock, Calendar, Gauge, Zap } from 'lucide-react';
import { quotaFillClass, quotaTextClass, calculateModulatedInstantQuota, MODEL_WEIGHTS, SAFE_WEEKLY_THRESHOLDS } from '../lib/quota';
import { cn } from '../lib/utils';

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

  React.useEffect(() => {
    setIsSwitching(false);
  }, [isActive, account.lastUsedAt]);

  const isBanned = account.isBanned || account.status === 'banned';
  const isAuthFailed = account.status === 'auth_failed';
  const isFree = !account.tierBadge || account.tierBadge === 'STANDARD FREE';
  const isProOrAbove = !isFree;

  // Group resolution
  const geminiGroup = account.geminiGroup || account.quotaGroups?.find((g) => g.id === 'gemini' || g.name.toLowerCase().includes('gemini'));
  const claudeGptGroup = account.claudeGptGroup || account.quotaGroups?.find((g) => g.id === 'claude_gpt' || g.name.toLowerCase().includes('claude') || g.name.toLowerCase().includes('gpt'));

  const quotas = account.quotas || [];
  const fiveHourQuotas = quotas.filter((q) => q.windowType === '5h' && !q.disabled && q.percentage >= 0);
  const weeklyQuotas = quotas.filter((q) => q.windowType === 'weekly' && !q.disabled && q.percentage >= 0);

  // Gemini buckets
  const gemini5h = geminiGroup?.fiveHour || fiveHourQuotas.find((q) => q.displayName.toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('flash'));
  const geminiWeekly = geminiGroup?.weekly || weeklyQuotas.find((q) => q.displayName.toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('pro'));

  // Claude & GPT buckets
  const claudeWeekly = claudeGptGroup?.weekly || weeklyQuotas.find((q) => q.displayName.toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('gpt'));
  const claude5h = claudeGptGroup?.fiveHour || fiveHourQuotas.find((q) => q.displayName.toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('gpt'));

  // Validity checks for buckets
  const validGemini5h = gemini5h && !gemini5h.disabled && gemini5h.percentage >= 0;
  const validGeminiWk = geminiWeekly && !geminiWeekly.disabled && geminiWeekly.percentage >= 0;
  const validClaude5h = claude5h && !claude5h.disabled && claude5h.percentage >= 0;
  const validClaudeWk = claudeWeekly && !claudeWeekly.disabled && claudeWeekly.percentage >= 0;

  // Instant quota calculations
  const hasGeminiData = gemini5h != null || geminiWeekly != null || geminiGroup != null;
  const geminiInstant: number | undefined = !hasGeminiData
    ? undefined
    : isFree
      ? (validGeminiWk ? geminiWeekly.percentage : geminiGroup?.buckets?.[0]?.percentage)
      : (validGemini5h && validGeminiWk
        ? calculateModulatedInstantQuota(gemini5h.percentage, geminiWeekly.percentage, SAFE_WEEKLY_THRESHOLDS.GEMINI)
        : validGemini5h
          ? gemini5h.percentage
          : validGeminiWk
            ? geminiWeekly.percentage
            : geminiGroup?.buckets?.[0]?.percentage);

  const hasClaudeData = claude5h != null || claudeWeekly != null || claudeGptGroup != null;
  const claudeInstant: number | undefined = !hasClaudeData
    ? undefined
    : isFree
      ? (validClaudeWk ? claudeWeekly.percentage : claudeGptGroup?.buckets?.[0]?.percentage)
      : (validClaude5h && validClaudeWk
        ? calculateModulatedInstantQuota(claude5h.percentage, claudeWeekly.percentage, SAFE_WEEKLY_THRESHOLDS.CLAUDE_GPT)
        : validClaude5h
          ? claude5h.percentage
          : validClaudeWk
            ? claudeWeekly.percentage
            : claudeGptGroup?.buckets?.[0]?.percentage);

  const hasQuotaData =
    (quotas.length > 0 ||
      geminiGroup != null ||
      claudeGptGroup != null ||
      account.weeklyQuotaPercentage != null ||
      account.fiveHourQuotaPercentage != null ||
      account.lastRefreshedAt != null) &&
    account.averageQuotaPercentage != null;

  const accountInstant: number | undefined = !hasQuotaData
    ? undefined
    : isFree
      ? (account.weeklyQuotaPercentage ?? account.averageQuotaPercentage ?? (geminiInstant != null && claudeInstant != null ? Math.round((geminiInstant * MODEL_WEIGHTS.GEMINI) + (claudeInstant * MODEL_WEIGHTS.CLAUDE)) : geminiInstant ?? claudeInstant))
      : (geminiInstant != null && claudeInstant != null
          ? Math.round((geminiInstant * MODEL_WEIGHTS.GEMINI) + (claudeInstant * MODEL_WEIGHTS.CLAUDE))
          : geminiInstant ?? claudeInstant ?? (() => {
              const p5h = account.fiveHourQuotaPercentage ?? (validGemini5h && validClaude5h ? Math.round((gemini5h.percentage * MODEL_WEIGHTS.GEMINI) + (claude5h.percentage * MODEL_WEIGHTS.CLAUDE)) : validGemini5h ? gemini5h.percentage : validClaude5h ? claude5h.percentage : undefined);
              const pWk = account.weeklyQuotaPercentage ?? account.averageQuotaPercentage;
              if (p5h !== undefined && pWk !== undefined) {
                return calculateModulatedInstantQuota(p5h, pWk, SAFE_WEEKLY_THRESHOLDS.DEFAULT);
              }
              return p5h ?? pWk;
            })());

  const getFillClass = quotaFillClass;
  const getTextColor = quotaTextClass;

  // Short status note for a bucket, derived from the API semantics.
  const bucketNote = (b: { disabled?: boolean; notStarted?: boolean; resetCountdown?: string; window?: string }) => {
    if (!b.resetCountdown) return '';
    return b.resetCountdown.toLowerCase().includes('ready') ? '• Ready' : `• resets ${b.resetCountdown}`;
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
              {account.statusMessage && (
                <div className="text-[10px] text-amber-400 mt-0.5">{account.statusMessage}</div>
              )}
            </div>
          </div>
        </div>

        {/* Quota Section: Separate Gemini and Claude & GPT, separate 5h and Weekly */}
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
              {/* Group 1: Gemini Models */}
              <div className="flex flex-col gap-1 rounded-md bg-accent/25 p-1.5 border border-border/40">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="font-semibold text-foreground flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                    Gemini Models
                  </span>
                  {isFree && !gemini5h && (
                    <span className="text-[9px] text-muted-foreground font-medium">Free Tier</span>
                  )}
                </div>

                {/* Gemini Instant Quota */}
                {geminiInstant != null && (
                  <div
                    className="flex flex-col gap-0.5 cursor-help"
                    title={`Gemini Instant Quota (${geminiInstant}%): Usable quota available right now, calculated from the 5h rolling window modulated by weekly capacity.`}
                  >
                    <div className="flex justify-between items-center text-[9px]">
                      <span className="flex items-center gap-1 min-w-0">
                        <Zap className="w-2.5 h-2.5 text-amber-400 shrink-0" />
                        <span className="text-foreground/90 font-medium">Instant</span>
                      </span>
                      <span className={`font-bold font-mono ml-1 shrink-0 ${getTextColor(geminiInstant)}`}>
                        {geminiInstant}%
                      </span>
                    </div>
                    <Progress
                      value={geminiInstant}
                      indicatorClassName={getFillClass(geminiInstant)}
                      className="h-1.5 w-full"
                    />
                  </div>
                )}

                {/* Gemini Sub-Windows: 5h Window & Weekly Plan Breakdown */}
                {(gemini5h || geminiWeekly) ? (
                  <div className="flex flex-col gap-1.5 pt-1.5 border-t border-border/30 mt-0.5">
                    {gemini5h && (
                      <div className="flex flex-col gap-0.5">
                        <div
                          className="flex items-center justify-between text-[9px] text-muted-foreground hover:text-foreground/90 transition-colors"
                          title={`5h: ${gemini5h.disabled ? 'N/A' : gemini5h.percentage + '%'} ${bucketNote(gemini5h)}`}
                        >
                          <span className="flex items-center gap-1 min-w-0">
                            <Clock className="w-2.5 h-2.5 text-sky-400 shrink-0" />
                            <span className="font-medium text-foreground/80">5h</span>
                          </span>
                          <div className="flex items-center gap-1.5 shrink-0 font-mono text-[9px]">
                            {gemini5h.resetCountdown && (
                              <span className="text-muted-foreground/80 font-normal">
                                {gemini5h.resetCountdown.toLowerCase().includes('ready') ? 'Ready' : `resets ${gemini5h.resetCountdown}`}
                              </span>
                            )}
                            {gemini5h.resetCountdown && <span className="text-muted-foreground/50 font-normal">•</span>}
                            <span className={cn("font-bold", gemini5h.disabled ? "text-muted-foreground" : getTextColor(gemini5h.percentage))}>
                              {gemini5h.disabled ? 'N/A' : `${gemini5h.percentage}%`}
                            </span>
                          </div>
                        </div>
                        <DashedProgress
                          value={gemini5h.percentage}
                          disabled={gemini5h.disabled}
                          indicatorClassName={gemini5h.disabled ? "bg-muted" : getFillClass(gemini5h.percentage)}
                          className="h-1.5 w-full"
                        />
                      </div>
                    )}

                    {geminiWeekly && (
                      <div className="flex flex-col gap-0.5">
                        <div
                          className="flex items-center justify-between text-[9px] text-muted-foreground hover:text-foreground/90 transition-colors"
                          title={`Weekly: ${geminiWeekly.percentage}% ${bucketNote(geminiWeekly)}`}
                        >
                          <span className="flex items-center gap-1 min-w-0">
                            <Calendar className="w-2.5 h-2.5 text-purple-400 shrink-0" />
                            <span className="font-medium text-foreground/80">Weekly</span>
                          </span>
                          <div className="flex items-center gap-1.5 shrink-0 font-mono text-[9px]">
                            {geminiWeekly.resetCountdown && (
                              <span className="text-muted-foreground/80 font-normal">
                                {geminiWeekly.resetCountdown.toLowerCase().includes('ready') ? 'Ready' : `resets ${geminiWeekly.resetCountdown}`}
                              </span>
                            )}
                            {geminiWeekly.resetCountdown && <span className="text-muted-foreground/50 font-normal">•</span>}
                            <span className={cn("font-bold", getTextColor(geminiWeekly.percentage))}>
                              {geminiWeekly.percentage}%
                            </span>
                          </div>
                        </div>
                        <DashedProgress
                          value={geminiWeekly.percentage}
                          disabled={geminiWeekly.disabled}
                          indicatorClassName={getFillClass(geminiWeekly.percentage)}
                          className="h-1.5 w-full"
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-[9px] text-muted-foreground">Standard access</div>
                )}
              </div>

              {/* Group 2: Claude & GPT Models */}
              <div className="flex flex-col gap-1 rounded-md bg-accent/25 p-1.5 border border-border/40">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="font-semibold text-foreground flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    Claude & GPT
                  </span>
                  {isFree && !claude5h ? (
                    <span className="text-[9px] text-muted-foreground font-medium">Free Tier</span>
                  ) : null}
                </div>

                {/* Claude & GPT Instant Quota */}
                {claudeInstant != null && (
                  <div
                    className="flex flex-col gap-0.5 cursor-help"
                    title={`Claude & GPT Instant Quota (${claudeInstant}%): Usable quota available right now, calculated from the 5h rolling window modulated by weekly capacity.`}
                  >
                    <div className="flex justify-between items-center text-[9px]">
                      <span className="flex items-center gap-1 min-w-0">
                        <Zap className="w-2.5 h-2.5 text-amber-400 shrink-0" />
                        <span className="text-foreground/90 font-medium">Instant</span>
                      </span>
                      <span className={`font-bold font-mono ml-1 shrink-0 ${getTextColor(claudeInstant)}`}>
                        {claudeInstant}%
                      </span>
                    </div>
                    <Progress
                      value={claudeInstant}
                      indicatorClassName={getFillClass(claudeInstant)}
                      className="h-1.5 w-full"
                    />
                  </div>
                )}

                {/* Claude Sub-Windows: 5h Window & Weekly Plan Breakdown */}
                {(claude5h || claudeWeekly) ? (
                  <div className="flex flex-col gap-1.5 pt-1.5 border-t border-border/30 mt-0.5">
                    {claude5h && (
                      <div className="flex flex-col gap-0.5">
                        <div
                          className="flex items-center justify-between text-[9px] text-muted-foreground hover:text-foreground/90 transition-colors"
                          title={`5h: ${claude5h.disabled ? 'N/A' : claude5h.percentage + '%'} ${bucketNote(claude5h)}`}
                        >
                          <span className="flex items-center gap-1 min-w-0">
                            <Clock className="w-2.5 h-2.5 text-sky-400 shrink-0" />
                            <span className="font-medium text-foreground/80">5h</span>
                          </span>
                          <div className="flex items-center gap-1.5 shrink-0 font-mono text-[9px]">
                            {claude5h.resetCountdown && (
                              <span className={cn("font-normal", claude5h.disabled ? "text-amber-400/90" : "text-muted-foreground/80")}>
                                {claude5h.resetCountdown.toLowerCase().includes('ready') ? 'Ready' : `resets ${claude5h.resetCountdown}`}
                              </span>
                            )}
                            {claude5h.resetCountdown && <span className="text-muted-foreground/50 font-normal">•</span>}
                            <span className={cn("font-bold", claude5h.disabled ? "text-muted-foreground" : getTextColor(claude5h.percentage))}>
                              {claude5h.disabled ? 'N/A' : `${claude5h.percentage}%`}
                            </span>
                          </div>
                        </div>
                        <DashedProgress
                          value={claude5h.percentage}
                          disabled={claude5h.disabled}
                          indicatorClassName={claude5h.disabled ? "bg-muted" : getFillClass(claude5h.percentage)}
                          className="h-1.5 w-full"
                        />
                      </div>
                    )}

                    {claudeWeekly && (
                      <div className="flex flex-col gap-0.5">
                        <div
                          className="flex items-center justify-between text-[9px] text-muted-foreground hover:text-foreground/90 transition-colors"
                          title={`Weekly: ${claudeWeekly.percentage}% ${bucketNote(claudeWeekly)}`}
                        >
                          <span className="flex items-center gap-1 min-w-0">
                            <Calendar className="w-2.5 h-2.5 text-purple-400 shrink-0" />
                            <span className="font-medium text-foreground/80">Weekly</span>
                          </span>
                          <div className="flex items-center gap-1.5 shrink-0 font-mono text-[9px]">
                            {claudeWeekly.resetCountdown && (
                              <span className="text-muted-foreground/80 font-normal">
                                {claudeWeekly.resetCountdown.toLowerCase().includes('ready') ? 'Ready' : `resets ${claudeWeekly.resetCountdown}`}
                              </span>
                            )}
                            {claudeWeekly.resetCountdown && <span className="text-muted-foreground/50 font-normal">•</span>}
                            <span className={cn("font-bold", getTextColor(claudeWeekly.percentage))}>
                              {claudeWeekly.percentage}%
                            </span>
                          </div>
                        </div>
                        <DashedProgress
                          value={claudeWeekly.percentage}
                          disabled={claudeWeekly.disabled}
                          indicatorClassName={getFillClass(claudeWeekly.percentage)}
                          className="h-1.5 w-full"
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-[9px] text-muted-foreground">Standard access</div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Total & Instant Account Quota Progress Bars */}
        {!isBanned && !isAuthFailed && (
          <div className="flex flex-col gap-1.5 rounded-md bg-accent/15 p-1.5 border border-border/30 mb-1.5">
            {/* Account Instant Quota */}
            <div
              className="flex flex-col gap-0.5 cursor-help"
              title={`Account Instant Quota (${hasQuotaData && accountInstant != null ? `${accountInstant}%` : '—'}): Effective usable quota available right now across all models for this account.`}
            >
              <div className="flex justify-between items-center text-[10px]">
                <span className="flex items-center gap-1 font-medium">
                  <Zap className="w-3 h-3 text-amber-400 shrink-0" />
                  <span className="text-foreground/90 font-semibold">Account Instant Quota</span>
                </span>
                <span className={cn("font-bold font-mono", hasQuotaData && accountInstant != null ? getTextColor(accountInstant) : "text-muted-foreground")}>
                  {hasQuotaData && accountInstant != null ? `${accountInstant}%` : '—'}
                </span>
              </div>
              <Progress
                value={hasQuotaData && accountInstant != null ? accountInstant : 0}
                indicatorClassName={hasQuotaData && accountInstant != null ? getFillClass(accountInstant) : "bg-transparent"}
                className="h-1.5 w-full"
              />
            </div>

            {/* Account Total Quota */}
            <div
              className="flex flex-col gap-0.5 cursor-help"
              title={`Account Total Quota (${hasQuotaData && account.averageQuotaPercentage != null ? `${account.averageQuotaPercentage}%` : '—'}): Total weekly quota capacity for this account.`}
            >
              <div className="flex justify-between items-center text-[10px]">
                <span className="flex items-center gap-1 font-medium">
                  <Gauge className="w-3 h-3 text-muted-foreground/80 shrink-0" />
                  <span className="text-foreground/90 font-semibold">Account Total Quota</span>
                </span>
                <span className={cn("font-bold font-mono", hasQuotaData ? getTextColor(account.averageQuotaPercentage!) : "text-muted-foreground")}>
                  {hasQuotaData ? `${account.averageQuotaPercentage}%` : '—'}
                </span>
              </div>
              <Progress
                value={hasQuotaData ? (account.averageQuotaPercentage ?? 0) : 0}
                indicatorClassName={hasQuotaData ? getFillClass(account.averageQuotaPercentage ?? 0) : "bg-transparent"}
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

            <Button
              onClick={handleRefresh}
              disabled={isRefreshing}
              size="iconXs"
              variant="outline"
              title="Refresh quota"
            >
              <RotateCw className={cn("w-3 h-3", isRefreshing && "animate-spin text-primary")} />
            </Button>

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
