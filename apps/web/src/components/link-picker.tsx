'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { Link2, Loader2, Search, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import type { VantageMatch } from '@mps/db/queries';
import { linkDeviceAction, searchVantageAction } from '@/app/(app)/issues/actions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

export interface LinkPickerProps {
  drmsId: string;
  /** What the operator calls this device — the dialog has to say what is being linked. */
  deviceLabel: string;
  /** Pre-filled search term, normally the DRMS serial: the likeliest match, one keystroke away. */
  defaultQuery?: string;
}

function matchLabel(row: VantageMatch): string {
  return row.serial ?? row.assetNumber ?? `Vantage ${row.vantageId}`;
}

/**
 * The "Link to…" dialog from the issues queue: search Vantage equipment, pick a record, write a
 * manual link. The only client component on this page — a typeahead over a table of 1,000+ Vantage
 * records genuinely needs one, and everything else on `/issues` stays a plain form or a link.
 */
export function LinkPicker({ drmsId, deviceLabel, defaultQuery }: LinkPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(defaultQuery ?? '');
  const [results, setResults] = useState<VantageMatch[] | null>(null);
  const [searching, startSearch] = useTransition();
  const [linking, startLink] = useTransition();

  const search = useCallback((term: string) => {
    startSearch(async () => {
      const rows = await searchVantageAction(term);
      setResults(rows);
    });
  }, []);

  // Opening the dialog runs the serial search straight away, because that is the search the
  // operator was about to type. Closing forgets the results so a stale list can't flash on reopen.
  useEffect(() => {
    if (!open) {
      setResults(null);
      setQuery(defaultQuery ?? '');
      return;
    }
    if (defaultQuery) search(defaultQuery);
  }, [open, defaultQuery, search]);

  function onLink(row: VantageMatch) {
    startLink(async () => {
      const result = await linkDeviceAction(drmsId, row.vantageId);
      if (result.ok) {
        setOpen(false);
        toast.success(`${deviceLabel} linked to ${matchLabel(row)}`);
      } else {
        toast.error(result.message);
      }
    });
  }

  const busy = searching || linking;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Link2 aria-hidden />
        Link to…
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Link {deviceLabel} to Vantage</DialogTitle>
          <DialogDescription>
            Search Vantage equipment by serial, asset number or customer. The link is recorded as
            manual, so the nightly link run will leave it alone.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            search(query);
          }}
          className="relative"
        >
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Serial, asset number or customer"
            aria-label="Search Vantage equipment"
            className="h-10 w-full rounded-lg border border-line bg-card pr-20 pl-9 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={busy} className="absolute top-1/2 right-2 -translate-y-1/2">
            Search
          </Button>
        </form>

        <div className="max-h-[340px] min-h-[120px] overflow-y-auto rounded-lg border border-line">
          {searching ? (
            <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              Searching…
            </p>
          ) : results === null ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Type at least two characters and press Search.
            </p>
          ) : results.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No Vantage equipment matches “{query}”.
            </p>
          ) : (
            <ul>
              {results.map((row) => (
                <li key={row.vantageId} className="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{matchLabel(row)}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {row.customerName ?? 'Unknown customer'} · Vantage {row.vantageId}
                      {row.assetNumber ? ` · Asset ${row.assetNumber}` : ''}
                    </span>
                    {row.linkedToDrmsId ? (
                      <span className="mt-1 flex items-center gap-1.5 text-xs text-warn">
                        <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
                        {row.linkedToDrmsId === drmsId
                          ? 'Already linked to this device'
                          : 'Held by another device — linking will take it over'}
                      </span>
                    ) : null}
                  </span>
                  <Button size="sm" disabled={busy} onClick={() => onLink(row)}>
                    Link
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
