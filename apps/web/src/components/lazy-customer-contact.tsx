'use client';

import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { loadDeviceContactAction, type ContactResult } from '@/app/(app)/contact-actions';
import { CustomerContact } from '@/components/customer-contact';

/**
 * The customer's phone (or its head office's), site contacts and the Vantage alert notes for one
 * machine, loaded through a server action when a row or popup is opened (as `LazyPartsPanel`).
 * Renders nothing while loading or when there is nothing to show, so a machine with no phone,
 * contacts or alerts adds no noise; a failure says so, with *Try again*.
 */
export function LazyCustomerContact({ vantageEquipmentId, className }: { vantageEquipmentId: number; className?: string }) {
  const [result, setResult] = useState<ContactResult | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    loadDeviceContactAction(vantageEquipmentId)
      .then((r) => {
        if (live) setResult(r);
      })
      .catch(() => {
        if (live) setResult({ ok: false, error: "Couldn't load contacts and alerts — try again" });
      });
    return () => {
      live = false;
    };
  }, [vantageEquipmentId, attempt]);

  if (result === null) return null;
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
  return <CustomerContact contact={result.data} showSource className={className} />;
}
