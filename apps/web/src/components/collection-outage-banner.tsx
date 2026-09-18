import { AlertTriangle } from 'lucide-react';
import type { CollectionStatus } from '@mps/db/queries';
import { cn } from 'cn';
import { formatDateTime, formatNumber, pluralise } from '@/lib/format';

export interface CollectionOutageBannerProps {
  status: CollectionStatus;
  className?: string;
}

/**
 * Shown when DRMS is far enough behind on collecting meter counters that the collection, not the
 * devices, is the likely cause.
 *
 * This is the correction the fleet asked for on 2026-09-18: the dashboard called 35 devices
 * "Offline" while CSRC showed every one of them online. All we actually know is how much of the
 * batch has come in, so the banner counts that rather than blaming the devices. Renders nothing
 * while collection is keeping up, so pages can drop it in unconditionally.
 */
export function CollectionOutageBanner({ status, className }: CollectionOutageBannerProps) {
  if (!status.outage) return null;

  const { devicesCollectedRecently: collected, devicesExpectingReadings: expecting } = status;

  return (
    <div
      role="status"
      className={cn(
        'mb-4 flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/5 px-5 py-4',
        className,
      )}
    >
      <AlertTriangle aria-hidden className="mt-0.5 size-[18px] shrink-0 text-warn" />
      <div className="min-w-0">
        <p className="text-[15px] font-medium text-warn">
          Meter readings are behind — only {formatNumber(collected)} of {formatNumber(expecting)}{' '}
          {pluralise(expecting, 'device')} {expecting === 1 ? 'has' : 'have'} reported in the last 24
          hours
        </p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          DRMS collects counters about once a day; per-device alerts are paused until collection catches up. Newest
          reading {formatDateTime(status.newestReadingAt)}.
        </p>
      </div>
    </div>
  );
}
