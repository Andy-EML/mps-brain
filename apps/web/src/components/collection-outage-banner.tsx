import { AlertTriangle } from 'lucide-react';
import type { CollectionStatus } from '@mps/db/queries';
import { cn } from 'cn';
import { formatDateTime, formatNumber, pluralise } from '@/lib/format';

export interface CollectionOutageBannerProps {
  status: CollectionStatus;
  className?: string;
}

/**
 * Shown when DRMS has collected no meter reading for *any* device.
 *
 * This is the correction the fleet asked for on 2026-09-18: the dashboard called 35 devices
 * "Offline" while CSRC showed every one of them online. The only thing we actually know is that
 * the nightly counter collection produced nothing, so the banner says that instead of blaming the
 * devices. Renders nothing when collection is running, so pages can drop it in unconditionally.
 */
export function CollectionOutageBanner({ status, className }: CollectionOutageBannerProps) {
  if (!status.outage) return null;

  const devices = status.devicesExpectingReadings;

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
          No meter readings received since {formatDateTime(status.newestReadingAt)}
        </p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          DRMS collects counters about once a day; this affects every device, so it looks like a collection problem
          rather than a device problem. All {formatNumber(devices)} {pluralise(devices, 'device')} that have ever
          reported are affected, so none of them is being treated as an individual fault.
        </p>
      </div>
    </div>
  );
}
