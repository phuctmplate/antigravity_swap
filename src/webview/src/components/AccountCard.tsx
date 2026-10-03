import React, { useState } from 'react';
import { Account } from '../types';
import { getVsCodeApi } from '../vscode';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Progress } from './ui/progress';
import { KeyRound, RotateCw, Trash2, ArrowRightLeft, ShieldAlert, AlertTriangle, Clock, Calendar } from 'lucide-react';
import { quotaFillClass, quotaTextClass } from '../lib/quota';

interface AccountCardProps {
  account: Account;
  isActive: boolean;
  isSelected: boolean;
  onSelect: (email: string) => void;
}

export const AccountCard: React.FC<AccountCardProps> = ({
  account,
  isActive,
  isSelected,
  onSelect
}) => {
  const [isSwitching, setIsSwitching] = useState(false);
  const vscode = getVsCodeApi();

  const isBanned = account.isBanned || account.status === 'banned';
  const isAuthFailed = account.status === 'auth_failed';
  const pct = account.averageQuotaPercentage || 0;
  const fhPct = account.fiveHourQuotaPercentage;
  const wkPct = account.weeklyQuotaPercentage;
  const hasWk = account.hasWeeklyQuota;
  const isFree = !account.tierBadge || account.tierBadge === 'STANDARD FREE';

  const getFillClass = quotaFillClass;
  const getTextColor = quotaTextClass;

  const handleSwitch = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsSwitching(true);
    vscode.postMessage({ command: 'switchAccount', email: account.email, isManual: true });
  };

  const handleRelogin = (e: React.MouseEvent) => {
    e.stopPropagation();
    vscode.postMessage({ command: 'relogin', email: account.email });
  };

  const handleRefresh = (e: React.MouseEvent) => {
    e.stopPropagation();
    vscode.postMessage({ command: 'refreshAccount', email: account.email });
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    vscode.postMessage({ command: 'removeAccount', email: account.email });
  };

  // Dynamic state classes based on Active / Selected hierarchy
  let cardClasses = 'relative flex flex-col transition-all duration-150 cursor-pointer overflow-hidden ';
  if (isBanned) {
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
      onClick={() => onSelect(account.email)}
      className={cardClasses}
    >
      {/* Active Left Vertical Accent Bar */}
      {isActive && (
        <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-gradient-to-b from-primary to-indigo-500" />
      )}

      {/* Selected Badge */}
      {isSelected && (
        <span className="absolute top-2 right-2 rounded-md bg-white/10 px-1.5 py-0.5 text-[9px] font-semibold text-foreground border border-white/20 pointer-events-none shadow-2xs">
          Selected
        </span>
      )}

      <CardContent className="flex flex-col flex-1 p-2.5">
        {/* Card Header: Avatar & Info */}
        <div className="flex items-center gap-2 mb-2 pr-14">
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
            </div>
            <div className="text-[10px] text-muted-foreground truncate">{account.email}</div>
            {account.statusMessage && (
              <div className="text-[10px] text-amber-400 mt-0.5">{account.statusMessage}</div>
            )}
          </div>
        </div>

        {/* Quota Section */}
        <div className="mt-1 mb-2 flex-1">
          {isBanned ? (
            <div className="text-[10px] font-medium text-destructive py-1 flex items-center gap-1">
              <ShieldAlert className="w-3 h-3 text-destructive" />
              <span>Account banned / suspended. Quota unavailable.</span>
            </div>
          ) : isAuthFailed ? (
            <div className="text-[10px] font-medium text-amber-400 py-1 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 text-amber-400" />
              <span>Authentication required. Click Re-login to authenticate.</span>
            </div>
          ) : !isFree && hasWk && fhPct != null && wkPct != null ? (
            <div className="flex flex-col gap-1.5">
              <div className="grid grid-cols-2 gap-1 text-center">
                <div className="rounded-md border border-border/80 bg-secondary/50 p-1">
                  <div className="text-[9px] uppercase text-muted-foreground flex items-center justify-center gap-1"><Clock className="w-2.5 h-2.5" />5h Window</div>
                  <div className={`text-[11px] font-bold ${getTextColor(fhPct)}`}>{fhPct}%</div>
                </div>
                <div className="rounded-md border border-border/80 bg-secondary/50 p-1">
                  <div className="text-[9px] uppercase text-muted-foreground flex items-center justify-center gap-1"><Calendar className="w-2.5 h-2.5" />Weekly</div>
                  <div className={`text-[11px] font-bold ${getTextColor(wkPct)}`}>{wkPct}%</div>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Progress
                  value={pct}
                  indicatorClassName={getFillClass(pct)}
                  className="h-1.5 flex-1"
                />
                <span className={`text-[10px] font-bold ${getTextColor(pct)}`}>{pct}%</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <div className="flex justify-between items-center text-[10px]">
                <span className="text-muted-foreground flex items-center gap-1">
                  {!isFree && fhPct != null ? (
                    <><Clock className="w-3 h-3" />5h: {fhPct}%</>
                  ) : hasWk && wkPct != null ? (
                    <><Calendar className="w-3 h-3" />Weekly: {wkPct}%</>
                  ) : (
                    `Quota Remaining: ${pct}%`
                  )}
                </span>
                <span className={`font-bold ${getTextColor(pct)}`}>{pct}%</span>
              </div>
              <Progress
                value={pct}
                indicatorClassName={getFillClass(pct)}
                className="h-1.5 w-full"
              />
            </div>
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
                title="Re-login account"
              >
                <KeyRound className="w-3 h-3" />
                <span>Re-login</span>
              </Button>
            )}

            <Button
              onClick={handleRefresh}
              size="iconXs"
              variant="outline"
              title="Refresh quota"
            >
              <RotateCw className="w-3 h-3" />
            </Button>

            <Button
              onClick={handleRemove}
              size="iconXs"
              variant="outline"
              title="Remove account"
            >
              <Trash2 className="w-3 h-3" />
            </Button>

            {!isActive && !isBanned && !isAuthFailed && (
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
