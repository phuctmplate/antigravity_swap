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
          'relative h-1.5 w-full overflow-hidden rounded-full bg-secondary',
          className
        )}
        {...props}
      >
        <div
          className={cn(
            'h-full rounded-full bg-primary transition-all duration-300',
            indicatorClassName
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

export { Progress };
