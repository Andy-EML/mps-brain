import { Printer } from 'lucide-react';
import { cn } from 'cn';

/** The product wordmark from the mockup: a printer glyph in the brand green, then the name. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <Printer className="size-[22px] text-brand" strokeWidth={1.75} aria-hidden />
      <span className="text-[17px] font-semibold tracking-tight text-foreground">MPS Dashboard</span>
    </span>
  );
}
