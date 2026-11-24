'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { SettingsError, addToPlan, getScheduledCall, markPmBooked, moveCard, removeFromPlan, setPriority } from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { parseBookedForm, pmErrorKey } from '@/lib/pm-action-form';
import { parsePlanForm } from '@/lib/pm-plan-form';
import { parseMoveForm, parseRemoveForm, plannerRedirectHref } from '@/lib/planner-form';
import { askNote, parseAskForm, parseSuggestionForm, upcomingAnchor, withAnchor } from '@/lib/planner-upcoming';

/**
 * `/pm/planner` card actions: Move to… (To plan / Asked engineer / Done), Book (the Mark-booked
 * form), Remove and the Priority star; and the upcoming-jobs panel's Asked engineer / Add to plan. Recorded in this app only — nothing is written to Vantage.
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

/**
 * `anchor` (the upcoming-jobs panel's `call-<id>`) replaces the `#card-<id>` hash so a suggestion's
 * action comes back to its call rather than jumping to the board.
 */
async function run(formData: FormData, work: (userId: number) => Promise<unknown>, anchor: string | null = null): Promise<void> {
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
  if (error !== null) redirect(withAnchor(plannerRedirectHref(back, card, error), anchor));
  revalidatePath('/pm/planner');
  revalidatePath('/pm');
  redirect(withAnchor(plannerRedirectHref(back, card), anchor));
}

/**
 * Move to To plan / Asked engineer / Done. The note is only changed when the form has a `note`
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
 * Upcoming jobs → *Asked engineer*: the office has rung the engineer about a PM near one of their
 * calls. The engineer and the call's day are read from the call (`getScheduledCall`), not the form.
 * Moves the machine to Asked engineer (putting it on the board when it is not on it — `moveCard`
 * inserts the plan row) and adds `Asked <engineer> for <call day>` under the card's note, keeping
 * whatever was typed there. Recorded here only: no notification is sent and nothing is written to
 * Vantage. A call that has gone from the diary, or has no engineer, is refused.
 */
export async function askEngineerAction(formData: FormData): Promise<void> {
  await run(
    formData,
    async (userId) => {
      const f = parseAskForm(formData);
      const db = getDb();
      const call = await getScheduledCall(db, f.workUnitId);
      if (call === null) throw new SettingsError('That PM action is not valid — check the form and try again.', 'invalid_pm_action');
      return moveCard(db, { vantageEquipmentId: f.vantageEquipmentId, to: 'asked', appendNote: askNote(call.engineerName, call.start), userId });
    },
    upcomingAnchor(formData.get('call')),
  );
}

/** Upcoming jobs → *Add to plan*: puts a suggested machine on the board in To plan. */
export async function addSuggestionToPlanAction(formData: FormData): Promise<void> {
  await run(
    formData,
    (userId) => addToPlan(getDb(), { vantageEquipmentIds: [parseSuggestionForm(formData).vantageEquipmentId], userId }),
    upcomingAnchor(formData.get('call')),
  );
}
