'use client';

import { useState, useTransition } from 'react';
import { Search } from 'lucide-react';
import { cn } from 'cn';
import { NOTE_SEARCH_MAX, NOTE_SEARCH_MIN } from '@mps/core';
import { searchVantageNotesAction, type NoteSearchActionResult } from '@/app/(app)/contact-actions';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/format';

/**
 * "Search Vantage notes": type a word, see every Vantage note that matches it (alert or not, on any
 * customer, machine or other record), live from Vantage. Read-only. `defaultWord` pre-fills the box
 * (e.g. the customer's account reference).
 */
export function VantageNoteSearch({ defaultWord = '', className }: { defaultWord?: string; className?: string }) {
  const [word, setWord] = useState(defaultWord);
  const [result, setResult] = useState<NoteSearchActionResult | null>(null);
  const [pending, start] = useTransition();

  return (
    <section aria-labelledby="note-search-heading" className={cn('rounded-xl border border-line bg-card p-4', className)}>
      <h2 id="note-search-heading" className="text-[15px] font-medium">
        Search Vantage notes
      </h2>
      <p className="mt-0.5 text-[12px] text-muted-foreground">
        Searches every note in Vantage (alerts and ordinary notes) for a word. Read-only. Common words such as “the” find nothing.
      </p>
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const w = word.trim();
          start(async () => {
            try {
              setResult(await searchVantageNotesAction(w));
            } catch {
              setResult({ ok: false, error: "Couldn't search Vantage — try again" });
            }
          });
        }}
      >
        <label htmlFor="note-search-word" className="sr-only">
          Word to search for
        </label>
        <input
          id="note-search-word"
          type="search"
          value={word}
          onChange={(e) => setWord(e.target.value)}
          minLength={NOTE_SEARCH_MIN}
          maxLength={NOTE_SEARCH_MAX}
          required
          placeholder="e.g. parking"
          className="h-8 w-56 rounded-md border border-line bg-background px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        />
        <Button type="submit" size="sm" variant="outline" disabled={pending || word.trim().length < NOTE_SEARCH_MIN}>
          <Search aria-hidden />
          {pending ? 'Searching…' : 'Search'}
        </Button>
      </form>
      <div aria-live="polite">
        {result && !result.ok ? (
          <p role="alert" className="mt-3 text-[13px] text-destructive">
            {result.error}
          </p>
        ) : null}
        {result && result.ok ? (
          result.notes.length === 0 ? (
            <p className="mt-3 text-[13px] text-muted-foreground">No notes found for “{result.word}”.</p>
          ) : (
            <>
              <p className="mt-3 text-[12px] text-muted-foreground">
                {result.more ? `First ${result.notes.length} notes` : `${result.notes.length} ${result.notes.length === 1 ? 'note' : 'notes'}`} for “
                {result.word}”
              </p>
              <ul className="mt-1.5 max-h-96 divide-y divide-line overflow-y-auto rounded-lg border border-line">
                {result.notes.map((n) => (
                  <li key={n.noteId} className={cn('px-3 py-2 text-[13px]', n.isAlert && 'bg-warn/10')}>
                    <p className="flex flex-wrap items-center gap-x-2 text-[12px]">
                      <span className="font-medium">{n.parentType ?? 'Note'}</span>
                      {n.parentReference ? <span className="text-muted-foreground">{n.parentReference}</span> : null}
                      {n.isAlert ? <span className="rounded bg-warn/20 px-1.5 text-[11px] font-medium text-warn">Alert</span> : null}
                    </p>
                    <p className="mt-0.5 break-words whitespace-pre-line">{n.text?.trim() || '(no text)'}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {[n.loggedDate ? `Logged ${formatDate(n.loggedDate)}` : null, n.loggedBy ? `by ${n.loggedBy}` : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )
        ) : null}
      </div>
    </section>
  );
}
