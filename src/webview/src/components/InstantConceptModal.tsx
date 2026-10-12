import React from 'react';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from './ui/dialog';
import { Button } from './ui/button';
import { Zap, AlertCircle, CheckCircle2, Layers, SlidersHorizontal } from 'lucide-react';

interface InstantConceptModalProps {
  children?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const InstantConceptModal: React.FC<InstantConceptModalProps> = ({
  children,
  open,
  onOpenChange,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {children && <DialogTrigger asChild>{children}</DialogTrigger>}
      <DialogContent className="sm:max-w-md gap-3.5 p-4.5">
        <DialogHeader className="gap-1">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-500/15 text-amber-500 shrink-0">
              <Zap className="w-4 h-4" />
            </div>
            <DialogTitle className="text-sm font-bold text-foreground">
              What is Instant Quota?
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs text-muted-foreground leading-relaxed pt-0.5">
            A real-time metric designed to prevent unexpected quota lockouts.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2.5 text-xs text-foreground/90 my-0.5">
          {/* The Problem */}
          <div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20">
            <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
            <div className="flex flex-col gap-0.5">
              <span className="font-semibold text-rose-600 dark:text-rose-400 text-[11px]">
                The Problem
              </span>
              <span className="text-muted-foreground text-[11px] leading-relaxed">
                Raw quotas can be misleading. An account may show a full 5-hour window, but run out of weekly limit minutes later—abruptly locking you out mid-task.
              </span>
            </div>
          </div>

          {/* The Solution */}
          <div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
            <div className="flex flex-col gap-0.5">
              <span className="font-semibold text-emerald-600 dark:text-emerald-400 text-[11px]">
                The Solution: Instant Quota
              </span>
              <span className="text-muted-foreground text-[11px] leading-relaxed">
                Instant Quota reflects your <strong className="text-foreground">true usable capacity right now</strong>. It continuously balances immediate burst availability against your weekly reserve so you never get unexpectedly locked out.
              </span>
            </div>
          </div>

          {/* Recommended Setting */}
          <div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-sky-500/10 border border-sky-500/20">
            <SlidersHorizontal className="w-4 h-4 text-sky-500 shrink-0 mt-0.5" />
            <div className="flex flex-col gap-0.5">
              <span className="font-semibold text-sky-600 dark:text-sky-400 text-[11px]">
                Recommended Setting: Auto-Switch at 5%
              </span>
              <span className="text-muted-foreground text-[11px] leading-relaxed">
                We recommend setting the Auto-Switch threshold to <strong className="text-foreground">5%</strong> (default). This provides a safe buffer that switches accounts smoothly before quota depletion, ensuring zero interrupted prompts.
              </span>
            </div>
          </div>

          {/* Quick Guide */}
          <div className="p-2.5 rounded-lg bg-muted/30 border border-border/50 text-[11px] flex flex-col gap-1.5">
            <span className="font-semibold text-foreground flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-amber-500" />
              Quick Guide
            </span>
            <ul className="text-muted-foreground space-y-1 pl-1">
              <li>
                <strong className="text-foreground">Model Instant:</strong> Usable burst quota for Gemini or Claude &amp; GPT.
              </li>
              <li>
                <strong className="text-foreground">Account Instant:</strong> Real usable capacity of this account right now.
              </li>
              <li>
                <strong className="text-foreground">Total Quota:</strong> Overall weekly plan reserve of this account.
              </li>
              <li>
                <strong className="text-foreground">Pool Quota:</strong> Combined resources across all accounts in your switcher.
              </li>
            </ul>
          </div>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button
              size="sm"
              className="w-full text-xs font-semibold cursor-pointer"
            >
              Got it
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
