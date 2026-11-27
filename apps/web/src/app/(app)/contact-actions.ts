'use server';

import { errorMessage, mapNoteSearchResult, noteSearchWord, type NoteSearchResult } from '@mps/core';
import { getDeviceContact, type ContactInfo } from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { parseMapIds } from '@/lib/planner-map';
import { getVantage } from '@/lib/vantage';

export type ContactResult = { ok: true; data: ContactInfo } | { ok: false; error: string };

/**
 * The customer's phone (or its head office's), its site contacts, and the machine's plus customer's
 * Vantage alert notes, by Vantage equipment id, for the panels opened on demand (the `/pm` row
 * detail, the PM map's Device details, PMs in area). Read only, from our copy. `requireUser()` first (a server action is a public POST).
 */
export async function loadDeviceContactAction(vantageEquipmentId: number): Promise<ContactResult> {
  await requireUser();
  let id: number;
  try {
    [id] = parseMapIds([vantageEquipmentId]) as [number];
  } catch {
    return { ok: false, error: 'Unknown machine' };
  }
  try {
    return { ok: true, data: await getDeviceContact(getDb(), { vantageEquipmentId: id }) };
  } catch (err) {
    console.error('[contact] load failed', err);
    return { ok: false, error: "Couldn't load contacts and alerts — try again" };
  }
}

/** Most matches a live search lists. */
const NOTE_SEARCH_LIMIT = 200;

export type NoteSearchActionResult =
  | { ok: true; word: string; notes: NoteSearchResult[]; more: boolean }
  | { ok: false; error: string };

/**
 * "Search Vantage notes": one live, read-only `GetNotesViaKeyword` search for the typed word, alert
 * and non-alert notes alike, first `NOTE_SEARCH_LIMIT` matches. Signed-in users only; the Vantage
 * credentials never leave the server.
 */
export async function searchVantageNotesAction(rawWord: unknown): Promise<NoteSearchActionResult> {
  const user = await requireUser();
  const word = noteSearchWord(rawWord);
  if (word === null) return { ok: false, error: 'Type a word of 2 to 50 characters' };
  try {
    const rows = await getVantage().searchNotes(word, { limit: NOTE_SEARCH_LIMIT + 1 });
    const notes = rows.map(mapNoteSearchResult).filter((n): n is NoteSearchResult => n !== null);
    console.log(`[notes] ${user.username ?? user.userId} searched Vantage notes (${notes.length} hits)`);
    return { ok: true, word, notes: notes.slice(0, NOTE_SEARCH_LIMIT), more: notes.length > NOTE_SEARCH_LIMIT };
  } catch (err) {
    console.error('[notes] Vantage search failed', errorMessage(err));
    return { ok: false, error: "Couldn't search Vantage — try again" };
  }
}
