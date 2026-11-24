import type { ReactNode } from 'react';
import { groupCardsByArea, type BoardCard, type PmPatch } from '@mps/db/queries';
import { PlannerCard } from '@/components/planner-card';
import { customerHref } from '@/components/customers';
import { deviceHref } from '@/lib/device-origin';
import { visibleColumnOf, type VisibleColumn } from '@/lib/planner-columns';
import { groupSummary, reasonBadgeText } from '@/lib/planner-form';

const COLUMNS: { key: VisibleColumn; label: string; hint: string }[] = [
  { key: 'planned', label: 'Planned', hint: 'Machines added to the plan; asked cards say who was asked.' },
  { key: 'booked', label: 'Booked', hint: 'Marked booked here, or a PM job is in Vantage.' },
];

export interface PlannerBoardProps {
  cards: BoardCard[];
  patches: PmPatch[];
  /** The first column: the PMs-in-area panel (engineers' calls with nearby PMs). */
  pmsInArea: ReactNode;
  /** The planner URL, posted back by every form and used as the device page's Back. */
  back: string;
  /** A refused action: the card it was on and the sentence to show there. */
  error: { card: number; message: string } | null;
}

/**
 * The planner board (server-rendered): three columns left to right — PMs in area (the slot), Planned
 * (stored To plan + Asked; an asked card carries an `Asked <engineer> · <day>` tag) and Booked —
 * side by side on wide screens and stacked below that. Done cards are not shown. Planned and Booked
 * group their cards county -> patch -> district with a count header ("GU14 · 5 due · 2 overdue ·
 * 1 priority"); the cards (`PlannerCard`) carry the actions. Display strings and links are worked out
 * here so the client card never imports database values.
 */
export function PlannerBoard({ cards, patches, pmsInArea, back, error }: PlannerBoardProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0">{pmsInArea}</div>
      {COLUMNS.map((col) => {
        const inColumn = cards.filter((c) => visibleColumnOf(c.column) === col.key);
        const groups = groupCardsByArea(inColumn, patches);
        const headingId = `planner-col-${col.key}`;
        return (
          <section key={col.key} aria-labelledby={headingId} className="flex min-w-0 flex-col rounded-xl border border-line bg-muted/20">
            <header className="border-b border-line px-4 py-3">
              <h2 id={headingId} className="flex items-baseline gap-2 text-[15px] font-semibold">
                {col.label}
                <span className="text-[13px] font-normal text-muted-foreground tabular-nums">{inColumn.length}</span>
              </h2>
              <p className="text-[12px] text-muted-foreground">{col.hint}</p>
            </header>
            <div className="flex flex-1 flex-col gap-4 p-3">
              {groups.length === 0 ? <p className="px-1 text-[13px] text-muted-foreground">No machines here.</p> : null}
              {groups.map((g) => (
                <div key={g.county}>
                  <h3 className="mb-2 text-[13px] font-semibold">{groupSummary(g.county, g.patches.flatMap((p) => p.districts.flatMap((d) => d.cards)))}</h3>
                  <div className="flex flex-col gap-3">
                    {g.patches.map((p) => (
                      <div key={p.name ?? '(no patch)'} className={p.name ? 'rounded-lg border border-line/70 p-2' : undefined}>
                        {p.name ? <p className="mb-1.5 text-[12px] font-medium text-muted-foreground">Patch: {p.name}</p> : null}
                        <div className="flex flex-col gap-3">
                          {p.districts.map((d) => (
                            <div key={d.district ?? '(no postcode)'}>
                              <h4 className="mb-1.5 text-[12px] text-muted-foreground">{groupSummary(d.district ?? 'No postcode', d.cards)}</h4>
                              <ul className="flex flex-col gap-2">
                                {d.cards.map((c) => (
                                  <PlannerCard
                                    key={c.vantageEquipmentId}
                                    card={c}
                                    back={back}
                                    badge={reasonBadgeText(c)}
                                    customerLink={c.customerId !== null ? customerHref(c.customerId) : null}
                                    deviceLink={c.drmsEquipmentId ? deviceHref(c.drmsEquipmentId, 'pm-planner', back) : null}
                                    error={error?.card === c.vantageEquipmentId ? error.message : null}
                                  />
                                ))}
                              </ul>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
