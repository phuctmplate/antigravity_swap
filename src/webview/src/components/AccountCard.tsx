import React, { useState } from 'react';
import { Account } from '../types';
import { getVsCodeApi } from '../vscode';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Progress } from './ui/progress';
import { KeyRound, RotateCw, Trash2, ArrowRightLeft, ShieldAlert, AlertTriangle, Clock, Calendar, CheckSquare, Square } from 'lucide-react';
import { quotaFillClass, quotaTextClass } from '../lib/quota';
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
  let cardClasses = 'relative flex flex-col transition-all duration-150 cursor-pointer overflow-hidden ';
  if (isMultiSelectMode && isChecked) {
    cardClasses += 'border-primary ring-2 ring-primary/80 bg-primary/15 shadow-md';
  } else if (isBanned) {
    cardClasses += isSelected
      ? 'border-destructive/80 bg-destructive/15 shadow-md'
      : 'border-destructive/40 bg-destructive/10 hover:border-destructive/60';
  } else if (isAuthFailed) {
    cardClasses += isSelected
      ? 'border-amber-500/80 bg-amber-500/15 shadow-md'
      : 'border-amber-500/40 bg-amber-500/10 hover:border-amber-500/60';
  } else if (isActive && isSelected) {
    cardClasses += 'border-primary/80 bg-primary/20 shadow-md shadow-primary/10 hover:bg-primary/25';
  } else if (isActive && !isSelected) {
    cardClasses += 'border-primary/45 bg-primary/10 hover:bg-primary/15';
  } else if (!isActive && isSelected) {
    cardClasses += 'border-foreground/35 bg-accent/60 shadow-md hover:bg-accent/80';
  } else {
    cardClasses += 'border-border/80 bg-card/80 hover:bg-accent/30 hover:border-border';
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
          className="absolute top-2 left-2 z-10 flex h-5 w-5 items-center justify-center rounded bg-card/90 shadow-xs border border-border/80 cursor-pointer hover:border-primary transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCheck?.(account.email);
          }}
          title={isChecked ? 'Deselect account' : 'Select account'}
        >
          {isChecked ? (
            <CheckSquare className="w-4 h-4 text-primary fill-primary/20" />
          ) : (
            <Square className="w-4 h-4 text-muted-foreground/60" />
          )}
        </div>
      )}

      {/* Active Left Vertical Accent Bar (hidden when multi-select to avoid clutter) */}
      {isActive && !isMultiSelectMode && (
        <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-gradient-to-b from-primary to-indigo-500" />
      )}

      {/* Selected Badge (Single Select view) */}
      {!isMultiSelectMode && isSelected && (
        <span className="absolute top-2 right-2 rounded-md bg-white/10 px-1.5 py-0.5 text-[9px] font-semibold text-foreground border border-white/20 pointer-events-none shadow-2xs">
          Selected
        </span>
      )}

      <CardContent className="flex flex-col flex-1 p-2.5">
        {/* Card Header: Avatar & Info */}
        <div className={cn("flex items-center gap-2 mb-2 pr-14", isMultiSelectMode && "pl-6")}>
          <div className="relative flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-pink-500 text-xs font-bold text-white overflow-hidden border border-white/20 shadow-xs">
            {account.avatarUrl ? (
              <img src={account.avatarUrl} alt={account.name || ''} className="h-full w-full object-cover" />
            ) : (
              avatarChar
            )}
          </div>

          <div className="flex flex-1 flex-col min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-bold text-xs text-foreground truncate max-w-[120px]">
                {account.name || account.email}
              </span>

              {/* Status & Tier Badges */}
              {isActive && (
                <Badge variant="default" className="text-[8px] px-1 py-0 font-extrabold">
                  ACTIVE
                </Badge>
              )}
              {isBanned && (
                <Badge variant="destructive" className="text-[8px] px-1 py-0 gap-0.5 font-extrabold">
                  <ShieldAlert className="w-2.5 h-2.5" />
                  <span>BANNED</span>
                </Badge>
              )}
              {isAuthFailed && (
                <Badge variant="warning" className="text-[8px] px-1 py-0 gap-0.5 font-extrabold">
                  <AlertTriangle className="w-2.5 h-2.5" />
                  <span>AUTH FAILED</span>
                </Badge>
              )}
              {account.tierBadge === 'ENTERPRISE' && (
                <Badge variant="success" className="text-[8px] px-1 py-0 font-extrabold">
                  ENTERPRISE
                </Badge>
              )}
              {account.tierBadge === 'ULTRA' && (
                <Badge variant="info" className="text-[8px] px-1 py-0 font-extrabold bg-purple-500/20 text-purple-300 border-purple-500/30">
                  ULTRA
                </Badge>
              )}
              {account.tierBadge === 'AI PREMIUM' && (
                <Badge variant="info" className="text-[8px] px-1 py-0 font-extrabold">
                  AI PREMIUM
                </Badge>
              )}
              {account.tierBadge === 'PRO' && (
                <Badge variant="pro" className="text-[8px] px-1 py-0 font-extrabold">
                  PRO
                </Badge>
              )}
              {isFree && (
                <Badge variant="outline" className="text-[8px] px-1 py-0 font-extrabold text-muted-foreground border-border/70 bg-muted/30">
                  FREE
                </Badge>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground truncate">{account.email}</div>
            {account.statusMessage && (
              <div className="text-[10px] text-amber-400 mt-0.5">{account.statusMessage}</div>
            )}
          </div>
        </div>

        {/* Quota Section: Separate Gemini and Claude & GPT, separate 5h and Weekly */}
        <div className="mt-1 mb-2 flex-1 flex flex-col gap-2">
          {isBanned ? (
            <div className="text-[10px] font-medium text-destructive py-1 flex items-center gap-1">
              <ShieldAlert className="w-3 h-3 text-destructive flex-shrink-0" />
              <span>Account suspended by Google Terms of Service.</span>
            </div>
          ) : isAuthFailed ? (
            <div className="text-[10px] font-medium text-amber-400 py-1 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 text-amber-400 flex-shrink-0" />
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
                    <span className="text-[8px] text-muted-foreground font-medium">Free Tier</span>
                  )}
                </div>

                {/* Gemini 5h Rolling Window */}
                {gemini5h && (
                  <div className="flex flex-col gap-0.5">
                    <div className="flex justify-between items-center text-[9px]">
                      <span className="text-muted-foreground flex items-center gap-1 min-w-0">
                        <Clock className="w-2.5 h-2.5 text-sky-400 flex-shrink-0" />
                        <span className="text-foreground/90 font-medium">5h Window</span>
                        <span className="text-[8px] text-muted-foreground/80 font-normal truncate">{bucketNote(gemini5h)}</span>
                      </span>
                      <span className={`font-bold ml-1 flex-shrink-0 ${gemini5h.disabled ? 'text-muted-foreground' : getTextColor(gemini5h.percentage)}`}>
                        {gemini5h.disabled ? 'N/A' : `${gemini5h.percentage}%`}
                      </span>
                    </div>
                    <Progress
                      value={gemini5h.disabled ? 0 : gemini5h.percentage}
                      indicatorClassName={gemini5h.disabled ? 'bg-muted-foreground/30' : getFillClass(gemini5h.percentage)}
                      className="h-1.5 w-full"
                    />
                  </div>
                )}

                {/* Gemini Weekly Plan Quota */}
                {geminiWeekly ? (
                  <div className="flex flex-col gap-0.5">
                    <div className="flex justify-between items-center text-[9px]">
                      <span className="text-muted-foreground flex items-center gap-1 min-w-0">
                        <Calendar className="w-2.5 h-2.5 text-purple-400 flex-shrink-0" />
                        <span className="text-foreground/90 font-medium">Weekly</span>
                        <span className="text-[8px] text-muted-foreground/80 font-normal truncate">{bucketNote(geminiWeekly)}</span>
                      </span>
                      <span className={`font-bold ml-1 flex-shrink-0 ${getTextColor(geminiWeekly.percentage)}`}>
                        {geminiWeekly.percentage}%
                      </span>
                    </div>
                    <Progress
                      value={geminiWeekly.percentage}
                      indicatorClassName={getFillClass(geminiWeekly.percentage)}
                      className="h-1.5 w-full"
                    />
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
                    <span className="text-[8px] text-muted-foreground font-medium">Free Tier</span>
                  ) : null}
                </div>

                {/* Claude 5h Rolling Window (Paid Tier) */}
                {claude5h && (
                  <div className="flex flex-col gap-0.5">
                    <div className="flex justify-between items-center text-[9px]">
                      <span className="text-muted-foreground flex items-center gap-1 min-w-0">
                        <Clock className="w-2.5 h-2.5 text-sky-400 flex-shrink-0" />
                        <span className="text-foreground/90 font-medium">5h Window</span>
                        <span className={`text-[8px] font-normal truncate ${claude5h.disabled ? 'text-amber-400/90' : 'text-muted-foreground/80'}`}>{bucketNote(claude5h)}</span>
                      </span>
                      <span className={`font-bold ml-1 flex-shrink-0 ${claude5h.disabled ? 'text-muted-foreground' : getTextColor(claude5h.percentage)}`}>
                        {claude5h.disabled ? 'N/A' : `${claude5h.percentage}%`}
                      </span>
                    </div>
                    <Progress
                      value={claude5h.disabled ? 0 : claude5h.percentage}
                      indicatorClassName={claude5h.disabled ? 'bg-muted-foreground/20' : getFillClass(claude5h.percentage)}
                      className="h-1.5 w-full"
                    />
                  </div>
                )}

                {/* Claude Weekly Plan Quota (All Tiers) */}
                {claudeWeekly ? (
                  <div className="flex flex-col gap-0.5">
                    <div className="flex justify-between items-center text-[9px]">
                      <span className="text-muted-foreground flex items-center gap-1 min-w-0">
                        <Calendar className="w-2.5 h-2.5 text-purple-400 flex-shrink-0" />
                        <span className="text-foreground/90 font-medium">Weekly</span>
                        <span className="text-[8px] text-muted-foreground/80 font-normal truncate">{bucketNote(claudeWeekly)}</span>
                      </span>
                      <span className={`font-bold ml-1 flex-shrink-0 ${getTextColor(claudeWeekly.percentage)}`}>
                        {claudeWeekly.percentage}%
                      </span>
                    </div>
                    <Progress
                      value={claudeWeekly.percentage}
                      indicatorClassName={getFillClass(claudeWeekly.percentage)}
                      className="h-1.5 w-full"
                    />
                  </div>
                ) : (
                  <div className="text-[9px] text-muted-foreground">Standard access</div>
                )}
              </div>
            </>
          )}
        </div>

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
                className="min-w-[56px]"
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
