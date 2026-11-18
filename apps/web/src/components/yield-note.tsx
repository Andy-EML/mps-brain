'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { YieldCheck } from '@mps/db/queries';
import { cn } from 'cn';
import { yieldNote } from '@/components/toner-yield';
import { ToneBadge } from '@/components/tone-badge';

/**
 * Proposal id (as a string key) to its yield check. The page loads every check in one batched
 * `getYieldCheckForProposals` call and provides them here, so each proposal line can look its own
 * up without the queue's props changing shape. A line with no check (none provided, or a colour
 * the device is not tracked for) shows nothing.
 */
export type YieldChecks = Record<string, YieldCheck>;

const YieldChecksContext = createContext<YieldChecks>({});

export function YieldChecksProvider({ checks, children }: { checks: YieldChecks; children: ReactNode }) {
  return <YieldChecksContext.Provider value={checks}>{children}</YieldChecksContext.Provider>;
}

/**
 * The yield line under a proposal: `Last ordered 22 Oct 2026 · 3,950 pages since (14% of 28,000)`,
 * with an amber *Early?* badge (the same text on hover) when the pages since are under half a rated
 * cartridge. `prefix` names the colour where the line does not already (an In progress order).
 */
export function ProposalYieldNote({ proposalId, prefix, className }: { proposalId: number; prefix?: string; className?: string }) {
  const check = useContext(YieldChecksContext)[String(proposalId)];
  if (!check) return null;
  const note = yieldNote(check);
  const text = prefix ? `${prefix}: ${note.text}` : note.text;
  return (
    <span className={cn('flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted-foreground', className)}>
      {note.early ? (
        <ToneBadge tone="warn" dot={false} className="px-2 py-0 text-[11px]">
          <span title={text}>Early?</span>
        </ToneBadge>
      ) : null}
      <span className="break-words">{text}</span>
    </span>
  );
}
