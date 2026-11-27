'use client';

import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { loadDevicePartsAction, type DevicePartsResult } from '@/app/(app)/pm/parts-actions';
import { PartsPanel } from '@/components/parts-panel';

const LOAD_FAILED = "Couldn't load parts — try again";

/**
 * The Parts panel loaded on demand through a server action: mount it when a row or popup is opened,
 * so lists never load parts for every machine up front. Loads once per mount (give it a `key` of the
 * machine id when the machine can change); *Try again* on failure.
 */
export function LazyPartsPanel({ vantageEquipmentId, className }: { vantageEquipmentId: number; className?: string }) {
  const [result, setResult] = useState<DevicePartsResult | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    loadDevicePartsAction(vantageEquipmentId)
      .then((r) => {
        if (live) setResult(r);
      })
      .catch(() => {
        if (live) setResult({ ok: false, error: LOAD_FAILED });
      });
    return () => {
      live = false;
    };
  }, [vantageEquipmentId, attempt]);

  if (result === null) {
    return (
      <p aria-live="polite" className={cn('text-[12px] text-muted-foreground', className)}>
        Loading parts…
      </p>
    );
  }
  if (!result.ok) {
    return (
      <p role="alert" className={cn('text-[12px] text-destructive', className)}>
        {result.error}{' '}
        <button
          type="button"
          onClick={() => {
            setResult(null);
            setAttempt((n) => n + 1);
          }}
          className="font-medium text-brand hover:underline"
        >
          Try again
        </button>
      </p>
    );
  }
  return <PartsPanel data={result.data} className={className} />;
}
