import { issueTypeLabel, type Tone } from './toner';

/**
 * Pure helpers behind `/issues`. Kept out of the page so the wording, the ordering and the
 * "which action applies to this row" rules can be tested without a DOM.
 */

/** The order the tabs and the table read best in: worst first, expected noise last. */
export const ISSUE_TYPE_ORDER = [
  'link_broken',
  'customer_mismatch',
  'no_match_drms',
  'serial_ambiguous',
  'erp_serial_disagree',
  'duplicate_target',
  'no_match_vantage',
] as const;

/** The type the queue hides by default: ~1,000 Vantage records that simply have no DRMS device. */
export const NOISY_TYPE = 'no_match_vantage';

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `no_match_drms` -> `No Vantage match`. Title-cased `issueTypeLabel`, for badges and tabs. */
export function issueTypeTitle(type: string): string {
  return sentenceCase(issueTypeLabel(type));
}

const CRITICAL_TYPES = new Set(['link_broken', 'duplicate_target']);

/**
 * `link_broken` and `duplicate_target` are the two that get billing wrong — a device that stopped
 * being linked, and two devices claiming one Vantage record. `no_match_vantage` is expected
 * (Vantage holds kit DRMS never monitored), so it is muted rather than shouting.
 */
export function issueTone(type: string): Tone {
  if (CRITICAL_TYPES.has(type)) return 'critical';
  if (type === NOISY_TYPE) return 'muted';
  return 'warn';
}

export interface DetailLine {
  label: string;
  value: string;
  /** Set when the value names something with a page of its own, so the table can link to it. */
  href?: string;
}

/** Labels for the `details` keys `computeLinks` actually writes. */
const DETAIL_LABELS: Record<string, string> = {
  erpId: 'DRMS ERP id',
  serialNorm: 'Normalised serial',
  vantageIds: 'Candidate Vantage ids',
  serialVantageId: 'Serial points at Vantage id',
  linkedDrmsId: 'Vantage record already held by',
  method: 'Match method',
  reason: 'Reason',
  status: 'DRMS status',
  drmsCustomerErpId: 'DRMS customer ERP id',
  vantageCustomerId: 'Vantage customer id',
  vantageCustomerReference: 'Vantage customer reference',
};

/** `link_broken` reasons, as `runLinkRun` stores them. */
const REASONS: Record<string, string> = {
  drms_missing: 'DRMS no longer lists this device',
  drms_status: 'DRMS status is not linkable',
  vantage_deleted: 'The Vantage record was deleted',
};

function humanise(key: string): string {
  return sentenceCase(
    key
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .toLowerCase(),
  );
}

/**
 * Flattens an issue's `details` jsonb into labelled lines. Unknown keys are humanised rather than
 * dropped, so a new issue type the linker starts raising is still readable here on day one.
 */
export function issueDetailLines(details: unknown): DetailLine[] {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return [];

  const lines: DetailLine[] = [];
  for (const [key, raw] of Object.entries(details as Record<string, unknown>)) {
    if (raw === null || raw === undefined || raw === '') continue;
    const value = Array.isArray(raw) ? raw.join(', ') : String(raw);
    if (value === '') continue;
    lines.push({
      label: DETAIL_LABELS[key] ?? humanise(key),
      value: key === 'reason' ? (REASONS[value] ?? value) : value,
      // A DRMS id on its own is an opaque GUID; linked, it answers "which device is that?".
      ...(key === 'linkedDrmsId' ? { href: `/devices/${value}` } : {}),
    });
  }
  return lines;
}

/** Just enough of an `IssueRow` for the action rules; keeps the tests free of fixture noise. */
export interface ActionableRow {
  type: string;
  drmsId: string | null;
  linkedVantageId: number | null;
}

/** Link is only meaningful when we know which DRMS device the operator is pointing somewhere. */
export function canLink(row: ActionableRow): boolean {
  return row.drmsId !== null;
}

const UNLINKABLE_TYPES = new Set(['link_broken', 'customer_mismatch']);

/** Unlink is for the two types that are complaints about a link that still exists. */
export function canUnlink(row: ActionableRow): boolean {
  return UNLINKABLE_TYPES.has(row.type) && row.linkedVantageId !== null;
}

export interface IssueTab {
  value: string;
  label: string;
  count: number;
}

/**
 * The tab row: `Needs attention` (everything but the expected `no_match_vantage`), one tab per
 * type that has rows, then `All`. Counts come from `listIssues`' `countsByType`, which is filtered
 * by status only — so switching tab never changes the numbers on the other tabs.
 */
export function issueTabs(countsByType: Record<string, number>): IssueTab[] {
  const present = Object.entries(countsByType).filter(([, n]) => n > 0);
  const rank = (type: string) => {
    const i = (ISSUE_TYPE_ORDER as readonly string[]).indexOf(type);
    return i === -1 ? ISSUE_TYPE_ORDER.length : i;
  };
  present.sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));

  const total = present.reduce((sum, [, n]) => sum + n, 0);
  return [
    { value: 'attention', label: 'Needs attention', count: total - (countsByType[NOISY_TYPE] ?? 0) },
    ...present.map(([type, count]) => ({ value: type, label: issueTypeTitle(type), count })),
    { value: 'all', label: 'All', count: total },
  ];
}
