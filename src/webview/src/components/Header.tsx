import React from 'react';
import { OverallQuotaSummary, Account } from '../types';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';
import { Clock, Calendar, Users, ShieldCheck, Sparkles } from 'lucide-react';
import { quotaFillClass, quotaTextClass, quotaStrokeColor } from '../lib/quota';
import { LogoIcon } from './LogoIcon';
import { GithubIcon } from './GithubIcon';
import { getVsCodeApi } from '../vscode';

interface HeaderProps {
  overall: OverallQuotaSummary;
  accounts: Account[];
}

export const Header: React.FC<HeaderProps> = ({ overall, accounts }) => {
  const instantPct = overall.instantPercentage ?? 0;
  const overallPct = overall.overallPercentage ?? 0;
  const radius = 32;
  const circumference = 2 * Math.PI * radius;
  const instantOffset = circumference - (instantPct / 100) * circumference;
  const overallOffset = circumference - (overallPct / 100) * circumference;

  const healthyCount = accounts.filter(
    (a) => !a.isBanned && a.status !== 'banned' && a.status !== 'auth_failed'
  ).length;

  const getGaugeColor = quotaStrokeColor;
  const getTextColor = quotaTextClass;
  const getProgressIndicator = quotaFillClass;

  const gemini5h = overall.gemini5HourPercentage;
  const geminiWk = overall.geminiWeeklyPercentage;
  const claude5h = overall.claude5HourPercentage;
  const claudeWk = overall.claudeWeeklyPercentage;
  const hasPro = (overall.proAccountsCount || 0) > 0;

  return (
    <div className="flex flex-col gap-2.5 mb-3">
      {/* Title Header */}
      <div className="flex items-center justify-between px-0.5 pt-0.5">
        <div className="flex items-center gap-2">
          <LogoIcon className="w-5 h-5 shrink-0 drop-shadow-sm" />
          <span className="font-bold text-sm tracking-tight text-foreground">
            Antigravity Swap
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              getVsCodeApi().postMessage({
                command: 'openUrl',
                url: 'https://github.com/phuctmplate/antigravity_swap'
              });
            }}
            className="p-1 rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 transition-colors flex items-center justify-center cursor-pointer"
            title="GitHub Repository (phuctmplate/antigravity_swap)"
            aria-label="GitHub Repository"
          >
            <GithubIcon className="w-3.5 h-3.5" />
          </button>
          <Badge variant="outline" className="text-[10px] text-muted-foreground/80 font-mono border-border/60 py-0 h-5">
            v1.1.1
          </Badge>
        </div>
      </div>

      {/* Hero Overview Card with Twin Circular Gauges */}
      <Card className="relative overflow-hidden border-border/80 bg-card/95 shadow-sm">
        <CardContent className="flex flex-col gap-2.5 p-3">
          {/* Twin SVG Gauges Container - Centered near middle on all screen widths */}
          <div className="flex items-center justify-center gap-6 sm:gap-10 max-w-sm mx-auto w-full px-2 py-1">
            {/* 1. Instant Quota Gauge */}
            <div
              className="flex flex-col items-center gap-1.5 min-w-24 shrink-0 cursor-help"
              title={`Instant Quota (${instantPct}%): Usable quota available right now across all healthy accounts (combines 5h window and free-tier weekly quotas).`}
            >
              <div className="relative flex h-20 w-20 shrink-0 items-center justify-center">
                <svg className="h-full w-full -rotate-90 transform" viewBox="0 0 80 80">
                  <circle
                    cx="40"
                    cy="40"
                    r={radius}
                    fill="none"
                    stroke="currentColor"
                    className="text-muted/60 dark:text-muted/30"
                    strokeWidth="6"
                  />
                  <circle
                    cx="40"
                    cy="40"
                    r={radius}
                    fill="none"
                    stroke={getGaugeColor(instantPct)}
                    strokeWidth="6"
                    strokeDasharray={circumference}
                    strokeDashoffset={instantOffset}
                    strokeLinecap="round"
                    style={{ transition: 'stroke-dashoffset 0.6s ease' }}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-base font-bold text-foreground tracking-tight">{instantPct}%</span>
                </div>
              </div>
              <div className="flex flex-col items-center text-center">
                <span className="text-xs font-bold text-foreground tracking-tight">Instant</span>
                <span className="text-[10px] text-muted-foreground font-medium whitespace-nowrap">Available Right Now</span>
              </div>
            </div>

            {/* Subtle Divider */}
            <div className="h-16 w-px bg-border/80 shrink-0" />

            {/* 2. Overall Quota Gauge */}
            <div
              className="flex flex-col items-center gap-1.5 min-w-24 shrink-0 cursor-help"
              title={`Overall Quota (${overallPct}%): Total weekly plan capacity across all healthy accounts.`}
            >
              <div className="relative flex h-20 w-20 shrink-0 items-center justify-center">
                <svg className="h-full w-full -rotate-90 transform" viewBox="0 0 80 80">
                  <circle
                    cx="40"
                    cy="40"
                    r={radius}
                    fill="none"
                    stroke="currentColor"
                    className="text-muted/60 dark:text-muted/30"
                    strokeWidth="6"
                  />
                  <circle
                    cx="40"
                    cy="40"
                    r={radius}
                    fill="none"
                    stroke={getGaugeColor(overallPct)}
                    strokeWidth="6"
                    strokeDasharray={circumference}
                    strokeDashoffset={overallOffset}
                    strokeLinecap="round"
                    style={{ transition: 'stroke-dashoffset 0.6s ease' }}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-base font-bold text-foreground tracking-tight">{overallPct}%</span>
                </div>
              </div>
              <div className="flex flex-col items-center text-center">
                <span className="text-xs font-bold text-foreground tracking-tight">Overall</span>
                <span className="text-[10px] text-muted-foreground font-medium whitespace-nowrap">Total Weekly Capacity</span>
              </div>
            </div>
          </div>

          {/* Hero Meta Info & Status Pills */}
          <div className="flex items-center justify-center flex-wrap gap-1.5 pt-2 border-t border-border/60">
            <Badge variant="secondary" className="gap-1 text-[10px] py-0.5 px-2">
              <Users className="w-3 h-3 text-muted-foreground" />
              <span>{accounts.length} Account{accounts.length !== 1 ? 's' : ''}</span>
            </Badge>
            <Badge variant="success" className="gap-1 text-[10px] py-0.5 px-2">
              <ShieldCheck className="w-3 h-3" />
              <span>{healthyCount} Healthy</span>
            </Badge>
            {hasPro && (
              <Badge variant="pro" className="gap-1 text-[10px] py-0.5 px-2">
                <Sparkles className="w-3 h-3 text-purple-700 dark:text-purple-300" />
                <span>{overall.proAccountsCount} Pro</span>
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Separated Gemini and Claude & GPT Overall Cards */}
      <div className="grid grid-cols-2 gap-2">
        {/* Gemini Models Card */}
        <Card className="bg-card/70 border-border/80">
          <CardContent className="flex flex-col gap-1.5 p-2.5">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-bold text-foreground flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                <span>Gemini</span>
              </div>
            </div>

            {/* 5h Rolling Window */}
            {hasPro && (
              <div className="flex flex-col gap-0.5">
                <div className="flex justify-between items-center text-[9px]">
                  <span className="text-muted-foreground flex items-center gap-1">
                    <Clock className="w-2.5 h-2.5 text-sky-400" />
                    <span>5h Window</span>
                  </span>
                  <span className={`font-bold ${gemini5h != null ? getTextColor(gemini5h) : 'text-muted-foreground'}`}>
                    {gemini5h != null ? `${gemini5h}%` : '—'}
                  </span>
                </div>
                <Progress
                  value={gemini5h ?? 0}
                  indicatorClassName={gemini5h != null ? getProgressIndicator(gemini5h) : 'bg-muted'}
                  className="h-1.5"
                />
              </div>
            )}

            {/* Weekly Plan Quota */}
            <div className="flex flex-col gap-0.5">
              <div className="flex justify-between items-center text-[9px]">
                <span className="text-muted-foreground flex items-center gap-1">
                  <Calendar className="w-2.5 h-2.5 text-purple-400" />
                  <span>Weekly</span>
                </span>
                <span className={`font-bold ${geminiWk != null ? getTextColor(geminiWk) : 'text-muted-foreground'}`}>
                  {geminiWk != null ? `${geminiWk}%` : '—'}
                </span>
              </div>
              <Progress
                value={geminiWk ?? 0}
                indicatorClassName={geminiWk != null ? getProgressIndicator(geminiWk) : 'bg-muted'}
                className="h-1.5"
              />
            </div>
          </CardContent>
        </Card>

        {/* Claude & GPT Models Card */}
        <Card className="bg-card/70 border-border/80">
          <CardContent className="flex flex-col gap-1.5 p-2.5">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-bold text-foreground flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                <span>Claude & GPT</span>
              </div>
            </div>

            {/* 5h Rolling Window */}
            {hasPro && (
              <div className="flex flex-col gap-0.5">
                <div className="flex justify-between items-center text-[9px]">
                  <span className="text-muted-foreground flex items-center gap-1">
                    <Clock className="w-2.5 h-2.5 text-sky-400" />
                    <span>5h Window</span>
                  </span>
                  <span className={`font-bold ${claude5h != null ? getTextColor(claude5h) : 'text-muted-foreground'}`}>
                    {claude5h != null ? `${claude5h}%` : '—'}
                  </span>
                </div>
                <Progress
                  value={claude5h ?? 0}
                  indicatorClassName={claude5h != null ? getProgressIndicator(claude5h) : 'bg-muted'}
                  className="h-1.5"
                />
              </div>
            )}

            {/* Weekly Plan Quota */}
            <div className="flex flex-col gap-0.5">
              <div className="flex justify-between items-center text-[9px]">
                <span className="text-muted-foreground flex items-center gap-1">
                  <Calendar className="w-2.5 h-2.5 text-purple-400" />
                  <span>Weekly</span>
                </span>
                <span className={`font-bold ${claudeWk != null ? getTextColor(claudeWk) : 'text-muted-foreground'}`}>
                  {claudeWk != null ? `${claudeWk}%` : '—'}
                </span>
              </div>
              <Progress
                value={claudeWk ?? 0}
                indicatorClassName={claudeWk != null ? getProgressIndicator(claudeWk) : 'bg-muted'}
                className="h-1.5"
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
