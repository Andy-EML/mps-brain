'use client';

import { useState, type DragEvent, type ReactNode } from 'react';
import { cn } from 'cn';
import { mapAddToPlanAction } from '@/app/(app)/pm/planner/map-actions';
import { usePlannerSave } from '@/components/planner-pms-in-area';
import { PM_IDS_MIME, dragIds } from '@/lib/planner-pms-in-area';

const carriesMachines = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(PM_IDS_MIME);

/**
 * The Planned column as a drop target: machines dragged from PMs in area are added to the plan
 * (`mapAddToPlanAction`), a toast says what happened and the board refreshes. Other drags are ignored.
 * The panel's *Add to plan* buttons do the same without dragging. The column itself stays server-rendered.
 */
export function PlannerDropZone({ children, className }: { children: ReactNode; className?: string }) {
  const [over, setOver] = useState(false);
  const { save, pending } = usePlannerSave();

  return (
    <div
      data-drop-target="planned"
      className={cn('relative rounded-xl transition-shadow', over && 'ring-2 ring-brand ring-offset-2', pending && 'opacity-70', className)}
      onDragEnter={(e) => {
        if (!carriesMachines(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!carriesMachines(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        // Leaving for a child is not leaving the column.
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setOver(false);
      }}
      onDrop={(e) => {
        if (!carriesMachines(e)) return;
        e.preventDefault();
        setOver(false);
        const ids = dragIds(e.dataTransfer.getData(PM_IDS_MIME));
        if (ids.length === 0) return;
        save(() => mapAddToPlanAction(ids));
      }}
    >
      {children}
      {over ? (
        <p
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-3 top-14 rounded-md bg-brand px-3 py-1.5 text-center text-[12px] font-medium text-white shadow"
        >
          Drop to add to the plan
        </p>
      ) : null}
    </div>
  );
}
