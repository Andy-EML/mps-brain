import {
  ALERT_NOTE_KEYWORDS,
  ApiError,
  AuthError,
  RateLimitError,
  chunk,
  errorMessage,
  mapAlertNote,
  mapCustomerPerson,
  noteSearchWord,
  type AlertNote,
  type CustomerPerson,
} from '@mps/core';
import { vantageAlertNotes, vantageCustomerPeople, type Db } from '@mps/db';
import type { VantageClient, VantageRecord } from '@mps/vantage';
import { and, isNull, lt, sql } from 'drizzle-orm';
import type { JobResult } from '../sync-runs';

const CHUNK = 500;

export interface VantageAlertNotesDeps {
  db: Db;
  vantage: Pick<VantageClient, 'searchNotes' | 'listCustomerPeople'>;
  now?: () => Date;
  /** Defaults to `ALERT_NOTE_KEYWORDS`. */
  keywords?: readonly string[];
}

/** An auth failure or a 429 ends the run: more calls would only fail too (or extend a block). */
function stopsRun(err: unknown): boolean {
  return err instanceof AuthError || err instanceof RateLimitError || (err instanceof ApiError && err.status === 429);
}

interface PeopleStats {
  people: number;
  primaryPeople: number;
  peopleDeleted: number;
}

/**
 * Full pull of Vantage's site contacts (`CustomerPerson`, live only) into `vantage_customer_people`:
 * upsert everyone with `last_seen_at` = this run and `deleted_at` cleared, then mark anyone the pull
 * did not return as deleted. An empty pull marks nobody (a blank answer is not "everyone left").
 */
async function pullCustomerPeople(db: Db, vantage: Pick<VantageClient, 'listCustomerPeople'>, startedAt: Date): Promise<PeopleStats> {
  const raws = await vantage.listCustomerPeople();
  const people = new Map<number, { person: CustomerPerson; raw: VantageRecord }>();
  for (const raw of raws) {
    const person = mapCustomerPerson(raw);
    if (person) people.set(person.personId, { person, raw });
  }
  const values = [...people.values()].map(({ person, raw }) => ({ ...person, raw, lastSeenAt: startedAt, deletedAt: null }));
  let peopleDeleted = 0;
  if (values.length > 0) {
    await db.transaction(async (tx) => {
      for (const batch of chunk(values, CHUNK)) {
        await tx
          .insert(vantageCustomerPeople)
          .values(batch)
          .onConflictDoUpdate({
            target: vantageCustomerPeople.personId,
            set: {
              customerId: sql`excluded.customer_id`,
              fullName: sql`excluded.full_name`,
              role: sql`excluded.role`,
              phone: sql`excluded.phone`,
              extension: sql`excluded.extension`,
              mobile: sql`excluded.mobile`,
              email: sql`excluded.email`,
              isPrimary: sql`excluded.is_primary`,
              modifiedDate: sql`excluded.modified_date`,
              raw: sql`excluded.raw`,
              lastSeenAt: sql`excluded.last_seen_at`,
              deletedAt: sql`null`,
            },
          });
      }
      const gone = await tx
        .update(vantageCustomerPeople)
        .set({ deletedAt: startedAt })
        .where(and(isNull(vantageCustomerPeople.deletedAt), lt(vantageCustomerPeople.lastSeenAt, startedAt)))
        .returning({ id: vantageCustomerPeople.personId });
      peopleDeleted = gone.length;
    });
  }
  return { people: values.length, primaryPeople: values.filter((v) => v.isPrimary).length, peopleDeleted };
}

/**
 * Read-only nightly copy of Vantage's alert notes (the popups) on customers and machines. Vantage
 * offers no notes list, only a keyword search, so every word in `ALERT_NOTE_KEYWORDS` is searched
 * in turn (one at a time, through the client's paging and auth) and the alert notes it reaches are
 * upserted with `last_seen_at` = this run. Notes a run does not reach keep their old time; readers
 * hide those after 7 days, so a note that stops being an alert (or is deleted) drops off.
 *
 * The same run first pulls the site contacts (`pullCustomerPeople`; separate stats). If that pull
 * fails the notes still run (partial), unless it was an auth error or a 429, which stops the run.
 *
 * A word that fails is skipped (partial); an auth error or a 429 stops the run and keeps what was
 * found so far; a run where the contacts pull and every word failed throws.
 */
export async function runVantageAlertNotes(deps: VantageAlertNotesDeps): Promise<JobResult> {
  const { db, vantage } = deps;
  const startedAt = (deps.now ?? (() => new Date()))();
  const words = [...new Set((deps.keywords ?? ALERT_NOTE_KEYWORDS).map(noteSearchWord).filter((w): w is string => w !== null))];

  let peopleStats: PeopleStats = { people: 0, primaryPeople: 0, peopleDeleted: 0 };
  let peopleError: unknown = null;
  let stopped: string | null = null;
  try {
    peopleStats = await pullCustomerPeople(db, vantage, startedAt);
  } catch (err) {
    if (stopsRun(err)) stopped = `stopped at contacts: ${errorMessage(err)}`;
    else peopleError = err;
  }

  const found = new Map<number, { note: AlertNote; raw: VantageRecord }>();
  let hits = 0;
  const failed: string[] = [];
  let firstError: unknown = null;

  for (const word of stopped ? [] : words) {
    let rows: VantageRecord[];
    try {
      rows = await vantage.searchNotes(word);
    } catch (err) {
      if (stopsRun(err)) {
        stopped = `stopped at "${word}": ${errorMessage(err)}`;
        break;
      }
      failed.push(word);
      firstError ??= err;
      continue;
    }
    hits += rows.length;
    for (const raw of rows) {
      const note = mapAlertNote(raw);
      if (note) found.set(note.noteId, { note, raw });
    }
  }

  if (!stopped && peopleError && (words.length === 0 || failed.length === words.length)) throw peopleError;

  const values = [...found.values()].map(({ note, raw }) => ({
    noteId: note.noteId,
    parentType: note.parentType,
    parentId: note.parentId,
    parentReference: note.parentReference,
    text: note.text,
    loggedDate: note.loggedDate,
    loggedBy: note.loggedBy,
    modifiedDate: note.modifiedDate,
    raw,
    lastSeenAt: startedAt,
  }));
  if (values.length > 0) {
    await db.transaction(async (tx) => {
      for (const batch of chunk(values, CHUNK)) {
        await tx
          .insert(vantageAlertNotes)
          .values(batch)
          .onConflictDoUpdate({
            target: vantageAlertNotes.noteId,
            set: {
              parentType: sql`excluded.parent_type`,
              parentId: sql`excluded.parent_id`,
              parentReference: sql`excluded.parent_reference`,
              text: sql`excluded.text`,
              loggedDate: sql`excluded.logged_date`,
              loggedBy: sql`excluded.logged_by`,
              modifiedDate: sql`excluded.modified_date`,
              raw: sql`excluded.raw`,
              lastSeenAt: sql`excluded.last_seen_at`,
            },
          });
      }
    });
  }

  const stats = {
    keywords: words.length,
    failedKeywords: failed.length,
    hits,
    alerts: values.length,
    customerAlerts: values.filter((v) => v.parentType === 'Customer').length,
    equipmentAlerts: values.filter((v) => v.parentType === 'Equipment').length,
    ...peopleStats,
    peopleFailed: peopleError !== null,
  };
  if (stopped) return { status: 'partial', stats, errorSample: stopped };
  const errors = [
    peopleError ? `contacts: ${errorMessage(peopleError)}` : null,
    failed.length > 0 ? `failed: ${failed.join(', ')} (${errorMessage(firstError)})` : null,
  ].filter((e): e is string => e !== null);
  if (errors.length > 0) return { status: 'partial', stats, errorSample: errors.join('; ') };
  return { status: 'success', stats };
}
