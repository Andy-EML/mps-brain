'use client';

import { useActionState, type ReactNode } from 'react';
import { FileUp, Loader2 } from 'lucide-react';
import type { ImportPreviewRow } from '@mps/db/queries';
import { cn } from 'cn';
import {
  applyImportAction,
  previewImportAction,
  type ImportApplyState,
  type ImportPreviewState,
} from '@/app/(app)/site-stock/import/actions';
import type { Tone } from '@/components/toner';
import { ToneBadge } from '@/components/tone-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const HEAD = 'px-4 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase whitespace-nowrap';
const CELL = 'px-4 py-3 align-top text-[13px]';

const ACTIONS: Record<ImportPreviewRow['action'], { label: string; tone: Tone }> = {
  create: { label: 'New shelf', tone: 'ok' },
  update: { label: 'Changed', tone: 'warn' },
  unchanged: { label: 'Unchanged', tone: 'muted' },
  error: { label: 'Error', tone: 'critical' },
};
const ORDER = ['create', 'update', 'unchanged', 'error'] as const;

function Alert({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
      {children}
    </div>
  );
}

/**
 * `/site-stock/import`: upload → preview → apply. *Preview* runs on the server and writes
 * nothing; the validated rows come back in a hidden field for *Apply*, which is disabled while any
 * row is an error. Apply redirects to `/site-stock` with a result banner.
 */
export function SiteStockImport() {
  const [state, previewAction, previewing] = useActionState(previewImportAction, {} as ImportPreviewState);

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-line bg-card px-5 py-4">
        <form action={previewAction} className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-md">
            <Label htmlFor="site-stock-file">CSV file</Label>
            <Input id="site-stock-file" name="file" type="file" accept=".csv,text/csv" required className="h-10 py-1.5" />
          </div>
          <Button type="submit" disabled={previewing} className="h-10 bg-brand hover:bg-brand/90">
            {previewing ? <Loader2 aria-hidden className="animate-spin" /> : <FileUp aria-hidden />}
            {previewing ? 'Reading…' : 'Preview'}
          </Button>
        </form>
        <p className="mt-2 text-[12px] text-muted-foreground">Up to 1 MB. Nothing changes until you press Apply.</p>
      </section>

      {state.fileError ? <Alert>{state.fileError}</Alert> : null}

      {state.errors ? (
        <Alert>
          <p className="font-medium">
            {state.fileName ? `${state.fileName}: ` : ''}fix these in the file and upload it again. Nothing has been imported.
          </p>
          <ul className="mt-2 list-disc pl-5">
            {state.errors.map((e) => (
              <li key={`${e.line}:${e.message}`}>
                Line {e.line}: {e.message}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {state.preview ? <Preview fileName={state.fileName} rows={state.preview} payload={state.payload} /> : null}
    </div>
  );
}

function Preview({ fileName, rows, payload }: { fileName?: string; rows: ImportPreviewRow[]; payload?: string }) {
  const counts = Object.fromEntries(ORDER.map((a) => [a, rows.filter((r) => r.action === a).length])) as Record<
    (typeof ORDER)[number],
    number
  >;
  const nothingToDo = counts.create === 0 && counts.update === 0;

  return (
    <section className="rounded-xl border border-line bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          {fileName ? <span className="font-medium">{fileName}</span> : null}
          {ORDER.filter((a) => counts[a] > 0).map((a) => (
            <ToneBadge key={a} tone={ACTIONS[a].tone} dot={false} className="px-2 py-0.5 text-[12px]">
              {counts[a]} {ACTIONS[a].label.toLowerCase()}
            </ToneBadge>
          ))}
        </div>
        {/* Keyed on the rows, so a fresh upload also clears an earlier Apply error. */}
        <ApplyForm key={payload ?? 'blocked'} payload={payload} nothingToDo={nothingToDo} />
      </div>

      {counts.error > 0 ? (
        <p className="border-t border-line px-5 py-3 text-[13px] text-destructive">
          {counts.error === 1 ? 'One row has an error' : `${counts.error} rows have errors`}. Fix the file and upload it again; nothing is
          applied until every row is right.
        </p>
      ) : null}

      <div className="w-full overflow-x-auto border-t border-line">
        <table className="w-full min-w-[760px] border-collapse text-left">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={cn(HEAD, 'text-right')}>Line</th>
              <th scope="col" className={HEAD}>Site</th>
              <th scope="col" className={HEAD}>Cartridge family</th>
              <th scope="col" className={HEAD}>Result</th>
              <th scope="col" className={HEAD}>Holdings</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.line} className={cn('border-b border-line last:border-b-0', r.action === 'error' && 'bg-destructive/5')}>
                <td className={cn(CELL, 'text-right text-muted-foreground tabular')}>{r.line}</td>
                <td className={cn(CELL, 'max-w-[300px]')}>
                  <span className="font-medium">{r.siteName || '—'}</span>
                  <p className="mt-0.5 text-[12px] text-muted-foreground tabular">Customer {r.vantageCustomerId}</p>
                </td>
                <td className={CELL}>{r.family}</td>
                <td className={CELL}>
                  <ToneBadge tone={ACTIONS[r.action].tone} dot={false} className="px-2 py-0.5 text-[12px]">
                    {ACTIONS[r.action].label}
                  </ToneBadge>
                </td>
                <td className={CELL}>
                  {r.changes.length > 0 ? <p>{r.changes.join(', ')}</p> : null}
                  {r.message ? (
                    <p className={cn('text-[12px]', r.action === 'error' ? 'text-destructive' : 'text-muted-foreground')}>{r.message}</p>
                  ) : null}
                  {r.changes.length === 0 && !r.message ? <span className="text-muted-foreground">—</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ApplyForm({ payload, nothingToDo }: { payload?: string; nothingToDo: boolean }) {
  const [state, applyAction, applying] = useActionState(applyImportAction, {} as ImportApplyState);
  return (
    <form action={applyAction} className="flex flex-col items-end gap-2">
      <input type="hidden" name="rows" value={payload ?? ''} />
      <Button type="submit" disabled={!payload || nothingToDo || applying} className="bg-brand hover:bg-brand/90">
        {applying ? <Loader2 aria-hidden className="animate-spin" /> : null}
        {applying ? 'Applying…' : 'Apply'}
      </Button>
      {nothingToDo && payload ? <p className="text-[12px] text-muted-foreground">Nothing to change.</p> : null}
      {state.error ? (
        <p role="alert" className="max-w-md text-right text-[12px] text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
