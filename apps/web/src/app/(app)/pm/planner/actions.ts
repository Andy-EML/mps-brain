'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  SettingsError,
  getEquipmentPm,
  markPmBooked,
  moveCard,
  removeFromPlan,
  setPriority,
  undoPmAction,
} from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { parseBookedForm, pmErrorKey } from '@/lib/pm-action-form';
import { parsePlanForm } from '@/lib/pm-plan-form';
import { parseMoveForm, parseRemoveForm, plannerRedirectHref } from '@/lib/planner-form';

/**
 * `/pm/planner` card actions: Book (the Mark-booked form), Back to Planned (undo a booking made
 * here), the note (`moveCardAction` to the card's own column), Remove and the Priority star.
 * (PMs in area's Add / Ask buttons are the map actions, `map-actions.ts`.) Recorded in this app only —
 * nothing is written to Vantage.
 * Each calls `requireUser()` first (an action is a public POST endpoint) and takes the user id from
 * the session, never the form. Every form posts `return` (the planner URL); the action goes back
 * there scrolled to the card. A refusal comes back as `card=<id>&plannerError=<key>` (the `/pm`
 * keys, see `pmErrorKey`), shown on that card; any other error is logged and shown as "Couldn't
 * save — try again".
 */

/** The machine id as posted, read before the full parse so even a refused form finds its card. */
function postedId(formData: FormData): number | null {
  const raw = formData.get('vantageEquipmentId');
  return typeof raw === 'string' && /^\d{1,10}$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

async function run(formData: FormData, work: (userId: number) => Promise<unknown>): Promise<void> {
  const user = await requireUser();
  const card = postedId(formData);
  const back = formData.get('return');
  let error: string | null = null;
  try {
    await work(user.userId);
  } catch (err) {
    if (!(err instanceof SettingsError)) console.error('[pm-planner] action failed', err);
    error = pmErrorKey(err);
  }
  // redirect() throws, so it stays outside the try.
  if (error !== null) redirect(plannerRedirectHref(back, card, error));
  revalidatePath('/pm/planner');
  revalidatePath('/pm');
  redirect(plannerRedirectHref(back, card));
}

/**
 * Move to To plan / Asked engineer (Done is not a board move). The note is only changed when the form has a `note`
 * field (the note form); the Move to… menu leaves the card's note as it is.
 */
export async function moveCardAction(formData: FormData): Promise<void> {
  await run(formData, (userId) => {
    const f = parseMoveForm(formData);
    return moveCard(getDb(), { vantageEquipmentId: f.vantageEquipmentId, to: f.to, note: formData.has('note') ? f.note : undefined, userId });
  });
}

export async function removeCardAction(formData: FormData): Promise<void> {
  await run(formData, (userId) => removeFromPlan(getDb(), { ...parseRemoveForm(formData), userId }));
}

export async function togglePriorityPlannerAction(formData: FormData): Promise<void> {
  await run(formData, (userId) => {
    const f = parsePlanForm(formData);
    if (f.on === null) throw new SettingsError('That PM action is not valid — check the form and try again.', 'invalid_pm_action');
    return setPriority(getDb(), { vantageEquipmentId: f.vantageEquipmentId, on: f.on, userId });
  });
}

/**
 * Move to Booked: the Mark-booked form (date + optional reference) writes the PM action Booked is
 * derived from, then the stored column is set to To plan so that, if the booking lapses (no visit
 * seen), the card falls back to To plan rather than to wherever it was before.
 */
export async function bookCardAction(formData: FormData): Promise<void> {
  await run(formData, async (userId) => {
    const f = parseBookedForm(formData);
    const db = getDb();
    await markPmBooked(db, { ...f, userId });
    await moveCard(db, { vantageEquipmentId: f.vantageEquipmentId, to: 'to_plan', userId });
  });
}

/**
 * *Back to Planned* on a card booked here: undoes the open booked PM action (`undoPmAction`, as
 * Undo on PM due does). `bookCardAction` left the stored column at To plan, so the card returns to
 * Planned. The action is looked up from the machine, not taken from the form; a machine with no
 * open booking recorded here (a Vantage PM job, or already undone) is refused.
 */
export async function unbookCardAction(formData: FormData): Promise<void> {
  await run(formData, async (userId) => {
    const { vantageEquipmentId } = parseRemoveForm(formData);
    const db = getDb();
    const row = await getEquipmentPm(db, vantageEquipmentId);
    const action = row?.action ?? null;
    if (action === null || action.kind !== 'booked') {
      throw new SettingsError('That PM action is not valid — check the form and try again.', 'invalid_pm_action');
    }
    return undoPmAction(db, action.id, userId);
  });
}
