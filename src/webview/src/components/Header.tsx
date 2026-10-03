import React from 'react';
import { OverallQuotaSummary, Account } from '../types';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';
import { Clock, Calendar, Users, ShieldCheck, Sparkles } from 'lucide-react';
import { quotaFillClass, quotaTextClass, quotaStrokeColor } from '../lib/quota';

interface HeaderProps {
  overall: OverallQuotaSummary;
  accounts: Account[];
}

export const Header: React.FC<HeaderProps> = ({ overall, accounts }) => {
  const pct = overall.overallPercentage || 0;
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (pct / 100) * circumference;

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
      {/* Hero Overview Card */}
      {/* NOTE: no backdrop-blur here — backdrop-filter inside VS Code webview iframes
          can blank the whole compositor layer to black on some GPUs. */}
      <Card className="relative overflow-hidden border-border/80 bg-card">
        <CardContent className="flex items-center gap-3.5 p-3.5">
          {/* Circular SVG Gauge */}
          <div className="relative flex h-16 w-16 flex-shrink-0 items-center justify-center">
            <svg className="h-full w-full -rotate-90 transform" viewBox="0 0 64 64">
              <circle
                cx="32"
                cy="32"
                r={radius}
                fill="none"
                stroke="oklch(0.3 0 0)"
                strokeWidth="5.5"
              />
              <circle
                cx="32"
                cy="32"
                r={radius}
                fill="none"
                stroke={getGaugeColor(pct)}
                strokeWidth="5.5"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                style={{ transition: 'stroke-dashoffset 0.6s ease' }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-sm font-bold text-foreground tracking-tight">{pct}%</span>
            </div>
          </div>

          {/* Hero Meta Info & Status Pills */}
          <div className="flex flex-1 flex-col gap-1.5 min-w-0">
            <div className="text-xs font-semibold text-foreground tracking-wide flex items-center gap-1.5">
              <span>Overall Quota</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="gap-1">
                <Users className="w-3 h-3 text-muted-foreground" />
                <span>{accounts.length} Account{accounts.length !== 1 ? 's' : ''}</span>
              </Badge>
              <Badge variant="success" className="gap-1">
                <ShieldCheck className="w-3 h-3" />
                <span>{healthyCount} Healthy</span>
              </Badge>
              {hasPro && (
                <Badge variant="pro" className="gap-1">
                  <Sparkles className="w-3 h-3 text-purple-400" />
                  <span>{overall.proAccountsCount} Pro</span>
                </Badge>
              )}
            </div>
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
