'use client';

import { useCallback, useMemo, useState, useTransition } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { LatLng, MapPin, UpcomingCall, UpcomingEngineer } from '@mps/db/queries';
import { cn } from 'cn';
import { mapAddToPlanAction, mapAskEngineerAction, mapSetPriorityAction, type MapActionResult } from '@/app/(app)/pm/planner/map-actions';
import type { MapCall, PinAction } from '@/components/planner-map-canvas';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatDayMonth } from '@/lib/format';
import { MAP_CONFIRM_OVER, MAP_IDS_MAX, farFromCall, pinDueText, selectInBox, unlocatedText, type Box } from '@/lib/planner-map';

// Leaflet touches `window` when it loads, so the canvas is client-only.
const PlannerMapCanvas = dynamic(() => import('@/components/planner-map-canvas').then((m) => m.PlannerMapCanvas), {
  ssr: false,
  loading: () => <div className="flex size-full items-center justify-center text-[13px] text-muted-foreground">Loading map…</div>,
});

export interface PlannerMapProps {
  pins: MapPin[];
  unlocated: number;
  engineers: UpcomingEngineer[];
  /** London dates (`YYYY-MM-DD`) of the two diary days. */
  today: string;
  tomorrow: string;
  nearMiles: number;
  /** DRMS device id per Vantage equipment id, for the popups' device links. */
  deviceIds: Record<number, string>;
}

type Day = 'today' | 'tomorrow';
type Mode = 'add' | 'ask';
interface DayCall extends UpcomingCall {
  engineerName: string;
}

const SAVE_FAILED = "Couldn't save — try again";

const dayLabel = (date: string) => formatDayMonth(new Date(`${date}T12:00:00Z`));
// Same as `callTimeText` in lib/planner-upcoming (not imported: that module pulls in @mps/db values).
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const callTimeText = (start: Date) => timeFormat.format(start);

/**
 * The PM planner's Map view: due PMs as pins, the engineers' calls for today or tomorrow, box
 * select, and the selection panel's *Add to plan* / *Ask <engineer> for <call>*. Selection is
 * client state; after an action it clears, a toast says what happened and the page data refreshes
 * while the map keeps its view. Recorded in this app only.
 */
export function PlannerMap({ pins, unlocated, engineers, today, tomorrow, nearMiles, deviceIds }: PlannerMapProps) {
  const router = useRouter();
  const [day, setDay] = useState<Day>('today');
  const [pickedCallId, setPickedCallId] = useState<number | null>(null);
  const [focus, setFocus] = useState<{ at: LatLng; n: number } | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [boxMode, setBoxMode] = useState(false);
  const [confirm, setConfirm] = useState<{ mode: Mode; far: number } | null>(null);
  const [pending, startTransition] = useTransition();

  const pinsById = useMemo(() => new Map(pins.map((p) => [p.vantageEquipmentId, p])), [pins]);
  const selectedPins = useMemo(() => selected.flatMap((id) => pinsById.get(id) ?? []), [selected, pinsById]);
  const selectedSet = useMemo(() => new Set(selectedPins.map((p) => p.vantageEquipmentId)), [selectedPins]);

  const dayEngineers = useMemo(
    () =>
      engineers
        .map((e) => ({ name: e.name, key: e.engineerId ?? e.name, calls: e.days.find((d) => d.which === day)?.calls ?? [] }))
        .filter((e) => e.calls.length > 0),
    [engineers, day],
  );
  const dayCalls: DayCall[] = useMemo(() => dayEngineers.flatMap((e) => e.calls.map((c) => ({ ...c, engineerName: e.name }))), [dayEngineers]);
  const mapCalls: MapCall[] = useMemo(
    () =>
      dayCalls.flatMap((c) =>
        c.at ? [{ workUnitId: c.workUnitId, at: c.at, label: `${c.engineerName} · ${callTimeText(c.start)} ${c.customerName ?? ''}`.trim() }] : [],
      ),
    [dayCalls],
  );
  const picked = dayCalls.find((c) => c.workUnitId === pickedCallId) ?? null;

  const onBox = useCallback(
    (box: Box) => {
      const ids = selectInBox(pins, box);
      setSelected((cur) => {
        const have = new Set(cur);
        return [...cur, ...ids.filter((id) => !have.has(id))];
      });
    },
    [pins],
  );
  const pickCall = useCallback((c: { workUnitId: number; at: LatLng | null }) => {
    setPickedCallId(c.workUnitId);
    const at = c.at;
    if (at) setFocus((f) => ({ at, n: (f?.n ?? 0) + 1 }));
  }, []);
  const onPickCall = useCallback(
    (id: number) => {
      const c = mapCalls.find((x) => x.workUnitId === id);
      if (c) pickCall(c);
    },
    [mapCalls, pickCall],
  );

  /** Runs a map action: toast the result and refresh the page data (the map keeps its view). */
  const save = useCallback(
    async (call: () => Promise<MapActionResult>): Promise<boolean> => {
      let r: MapActionResult;
      try {
        r = await call();
      } catch {
        toast.error(SAVE_FAILED);
        return false;
      }
      if (!r.ok) {
        toast.error(r.error);
        return false;
      }
      toast.success(r.text);
      router.refresh();
      return true;
    },
    [router],
  );
  const onPinAction = useCallback(
    (a: PinAction) =>
      startTransition(async () => {
        await save(() => (a.kind === 'add' ? mapAddToPlanAction([a.id]) : mapSetPriorityAction(a.id, a.on)));
      }),
    [save],
  );

  const count = selectedPins.length;
  const tooMany = count > MAP_IDS_MAX;

  const run = (mode: Mode) => {
    const ids = selectedPins.map((p) => p.vantageEquipmentId);
    const call = picked;
    setConfirm(null);
    if (mode === 'ask' && !call) return;
    startTransition(async () => {
      const ok = await save(() => (mode === 'add' || !call ? mapAddToPlanAction(ids) : mapAskEngineerAction(ids, call.workUnitId)));
      if (ok) setSelected([]);
    });
  };

  const act = (mode: Mode) => {
    if (count === 0 || tooMany || (mode === 'ask' && !picked)) return;
    const far = mode === 'ask' && picked ? farFromCall(selectedPins, picked, nearMiles) : 0;
    if (count > MAP_CONFIRM_OVER || far > 0) setConfirm({ mode, far });
    else run(mode);
  };

  const askLabel = picked ? `Ask ${picked.engineerName} for ${callTimeText(picked.start)} ${picked.customerName ?? 'call'}` : 'Ask engineer';
  const note = unlocatedText(unlocated);

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <section aria-label="Map" className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Button variant={boxMode ? 'default' : 'outline'} size="sm" aria-pressed={boxMode} onClick={() => setBoxMode((v) => !v)}>
            Select area
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSelected([])} disabled={count === 0}>
            Clear
          </Button>
          <span className="text-[12px] text-muted-foreground">or Shift+drag on the map</span>
          <Legend />
        </div>
        {/* `isolate`: Leaflet's panes use z-index 400+; keep them under the app's dialogs and menus. */}
        <div className="isolate h-[65vh] min-h-[360px] overflow-hidden rounded-xl border border-line bg-muted">
          <PlannerMapCanvas
            pins={pins}
            deviceIds={deviceIds}
            selected={selectedSet}
            calls={mapCalls}
            pickedCallId={picked?.workUnitId ?? null}
            focus={focus}
            nearMiles={nearMiles}
            boxMode={boxMode}
            onBox={onBox}
            onPickCall={onPickCall}
            onPinAction={onPinAction}
          />
        </div>
        <p className="mt-2 text-[12px] text-muted-foreground">
          {pins.length} {pins.length === 1 ? 'machine' : 'machines'} on the map
          {note ? ` · ${note}` : ''}
        </p>
      </section>

      <aside className="min-w-0 space-y-4">
        <section aria-labelledby="map-selection-heading" className="rounded-xl border border-line bg-card p-4">
          <h2 id="map-selection-heading" className="text-[14px] font-semibold">
            Selected: {count}
          </h2>
          {count === 0 ? (
            <p className="mt-1 text-[13px] text-muted-foreground">Draw a box round pins to select them.</p>
          ) : (
            <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto pr-1">
              {selectedPins.map((p) => (
                <li key={p.vantageEquipmentId} className="flex items-start gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked
                    onChange={() => setSelected((cur) => cur.filter((id) => id !== p.vantageEquipmentId))}
                    aria-label={`Untick ${p.customerName ?? 'machine'} ${p.serial ?? ''}`.trim()}
                    className="mt-1 shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="font-medium break-words">{p.customerName ?? 'Unknown customer'}</p>
                    <p className="text-[12px] break-words text-muted-foreground">
                      {[p.town, p.model, p.serial].filter(Boolean).join(' · ')}
                    </p>
                    <p className={cn('text-[12px]', p.status === 'overdue' && !p.whenInArea ? 'text-critical' : 'text-muted-foreground')}>
                      {pinDueText(p)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {tooMany ? <p className="mt-2 text-[12px] text-destructive">Up to {MAP_IDS_MAX} machines at a time.</p> : null}
          <div className="mt-3 flex flex-col gap-2">
            <Button onClick={() => act('add')} disabled={pending || count === 0 || tooMany}>
              Add to plan
            </Button>
            <Button
              variant="outline"
              onClick={() => act('ask')}
              disabled={pending || count === 0 || tooMany || !picked}
              title={picked ? undefined : 'Pick a call first'}
              className="h-auto min-h-8 whitespace-normal py-1.5 text-left"
            >
              {askLabel}
            </Button>
            {!picked ? <p className="text-[12px] text-muted-foreground">Pick a call first</p> : null}
          </div>
        </section>

        <section aria-labelledby="map-calls-heading" className="rounded-xl border border-line bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="map-calls-heading" className="text-[14px] font-semibold">
              Engineers&apos; calls
            </h2>
            <div role="group" aria-label="Day" className="flex flex-wrap gap-1">
              {(['today', 'tomorrow'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={day === d}
                  onClick={() => setDay(d)}
                  className={cn(
                    'rounded-full px-3 py-1 text-[13px] transition-colors',
                    day === d ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {d === 'today' ? 'Today' : 'Tomorrow'} <span className="text-muted-foreground">{dayLabel(d === 'today' ? today : tomorrow)}</span>
                </button>
              ))}
            </div>
          </div>
          {dayEngineers.length === 0 ? (
            <p className="mt-2 text-[13px] text-muted-foreground">No booked calls {day === 'today' ? 'today' : 'tomorrow'}.</p>
          ) : (
            <ul className="mt-2 space-y-3">
              {dayEngineers.map((e) => (
                <li key={e.key}>
                  <p className="text-[13px] font-medium">{e.name}</p>
                  <ul className="mt-1 space-y-0.5">
                    {e.calls.map((c) => {
                      const isPicked = c.workUnitId === picked?.workUnitId;
                      return (
                        <li key={c.workUnitId}>
                          <button
                            type="button"
                            aria-pressed={isPicked}
                            onClick={() => pickCall(c)}
                            className={cn(
                              'flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-[13px] transition-colors',
                              isPicked ? 'bg-brand-soft ring-1 ring-brand' : 'hover:bg-muted',
                            )}
                          >
                            <span className="shrink-0 tabular-nums">{callTimeText(c.start)}</span>
                            <span className="min-w-0 flex-1 break-words">
                              {c.customerName ?? 'Unknown customer'}
                              {c.district ? <span className="text-muted-foreground"> · {c.district}</span> : null}
                            </span>
                            {c.at === null ? <span className="shrink-0 text-[11px] text-muted-foreground">no location</span> : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {picked ? (
            <p className="mt-3 text-[12px] text-muted-foreground">
              Ring: {nearMiles} miles round the picked call.{' '}
              <button type="button" className="text-brand hover:underline" onClick={() => setPickedCallId(null)}>
                Unpick
              </button>
            </p>
          ) : null}
        </section>
      </aside>

      <Dialog open={confirm !== null} onOpenChange={(open) => (open ? null : setConfirm(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.mode === 'ask' && picked ? askLabel : 'Add to plan'}?</DialogTitle>
            <DialogDescription>
              {count} {count === 1 ? 'machine' : 'machines'} selected.
              {confirm && confirm.far > 0 ? ` ${confirm.far} of these are over ${nearMiles} miles from the call.` : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button onClick={() => confirm && run(confirm.mode)} disabled={pending}>
              {confirm?.mode === 'ask' ? 'Ask engineer' : 'Add to plan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Legend() {
  const item = 'inline-flex items-center gap-1';
  return (
    <ul aria-label="Key" className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
      <li className={item}>
        <span className="size-2.5 rounded-full bg-critical" /> Overdue
      </li>
      <li className={item}>
        <span className="size-2.5 rounded-full bg-warn" /> Due soon
      </li>
      <li className={item}>
        <span className="size-2.5 rounded-full bg-muted-foreground/60" /> When in area
      </li>
      <li className={item}>
        <span aria-hidden className="text-[13px] leading-none text-critical">★</span> Priority
      </li>
      <li className={item}>
        <span className="size-2.5 rounded-full border-2 border-muted-foreground bg-card" /> Approximate
      </li>
      <li className={item}>
        <span className="size-2.5 rounded-full ring-2 ring-foreground" /> On the board
      </li>
      <li className={item}>
        <span className="size-2.5 rounded-[2px] bg-blue-600" /> Engineer call
      </li>
    </ul>
  );
}
