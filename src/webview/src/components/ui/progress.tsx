import * as React from 'react';
import { cn } from '../../lib/utils';

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  indicatorClassName?: string;
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value = 0, indicatorClassName, ...props }, ref) => {
    const clamped = Math.min(100, Math.max(0, value ?? 0));

    return (
      <div
        ref={ref}
        className={cn(
          'relative h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/15',
          className
        )}
        {...props}
      >
        <div
          className={cn(
            'h-full rounded-full transition-all duration-300',
            indicatorClassName || 'bg-primary'
          )}
          style={{
            width: `${clamped}%`,
            opacity: clamped > 0 ? 1 : 0
          }}
        />
      </div>
    );
  }
);
Progress.displayName = 'Progress';

export interface DashedProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  segments?: number;
  indicatorClassName?: string;
  disabled?: boolean;
}

const DashedProgress = React.forwardRef<HTMLDivElement, DashedProgressProps>(
  (
    {
      className,
      value = 0,
      segments = 10,
      indicatorClassName,
      disabled = false,
      ...props
    },
    ref
  ) => {
    const clamped = Math.min(100, Math.max(0, value ?? 0));
    const segmentRange = 100 / segments;

    return (
      <div
        ref={ref}
        className={cn('flex w-full items-center gap-[2.5px] h-1.5', className)}
        {...props}
      >
        {Array.from({ length: segments }).map((_, idx) => {
          const segmentStart = idx * segmentRange;
          const segmentEnd = (idx + 1) * segmentRange;
          let fillPct = 0;
          if (!disabled && clamped > segmentStart) {
            if (clamped >= segmentEnd) {
              fillPct = 100;
            } else {
              fillPct = Math.min(
                100,
                Math.max(0, ((clamped - segmentStart) / segmentRange) * 100)
              );
            }
          }

          return (
            <div
              key={idx}
              className="flex-1 h-full rounded-full bg-black/10 dark:bg-white/15 relative overflow-hidden"
            >
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-300',
                  indicatorClassName || 'bg-primary',
                  'opacity-85'
                )}
                style={{
                  width: `${fillPct}%`,
                  opacity: fillPct > 0 ? undefined : 0,
                }}
              />
            </div>
          );
        })}
      </div>
    );
  }
);
DashedProgress.displayName = 'DashedProgress';

export { Progress, DashedProgress };
