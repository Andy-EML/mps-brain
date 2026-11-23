import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ISSUE_SORT_KEYS, listIssues } from '@mps/db/queries';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { IssueTable } from '@/components/issue-table';
import { issueTabs, NOISY_TYPE } from '@/components/issue-queue';
import { PageHeader } from '@/components/page-header';
import { ListControls } from '@/components/list-controls';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber, pluralise } from '@/lib/format';
import { lastPageOf, listHref, parseListState, rowsCookieName, sortSpec, stateParams } from '@/lib/list-state';

export const metadata = { title: 'Link issues · MPS Dashboard' };

const LIST_KEY = 'issues';
const DEFAULT_ROWS = 50;

const STATUSES = [
  { value: 'open', label: 'Open' },
  { value: 'ignored', label: 'Ignored' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'any', label: 'Any status' },
] as const satisfies readonly FilterTab[];

type Status = (typeof STATUSES)[number]['value'];

/** The tab a bare `/issues` shows: everything except the ~1,000 expected `no_match_vantage` rows. */
const DEFAULT_TYPE = 'attention';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function IssuesPage({ searchParams }: PageProps<'/issues'>) {
  // First statement, before anything else touches the request: the (app) layout's own
  // requireUser() does not gate this page, because Next fetches layout and page data in parallel.
  await requireUser();
  const params = await searchParams;

  const requestedStatus = first(params.status);
  const status: Status = STATUSES.some((s) => s.value === requestedStatus) ? (requestedStatus as Status) : 'open';
  const type = first(params.type) ?? DEFAULT_TYPE;
  const cookieStore = await cookies();
  const state = parseListState((name) => first(params[name]), {
    listKey: LIST_KEY,
    defaultRows: DEFAULT_ROWS,
    sortKeys: ISSUE_SORT_KEYS,
    cookieRows: cookieStore.get(rowsCookieName(LIST_KEY))?.value,
  });
  const page = state.page;

  const { rows, total, countsByType } = await listIssues(getDb(), {
    status: status === 'any' ? undefined : status,
    // `attention` and `all` are views, not types: one hides the expected noise, the other hides
    // nothing. Anything else is a real issue type and filters to it.
    type: type === DEFAULT_TYPE || type === 'all' ? undefined : type,
    excludeTypes: type === DEFAULT_TYPE ? [NOISY_TYPE] : undefined,
    limit: state.rows,
    offset: (page - 1) * state.rows,
    sort: sortSpec(state),
  });

  // Carried on the tab links and the pager so switching one control keeps the others.
  const typeParam = type === DEFAULT_TYPE ? undefined : type;
  const statusParam = status === 'open' ? undefined : status;

  // A page number past the end (a stale bookmark, or a tab whose rows an operator just cleared)
  // would otherwise render an empty state over a list that does have rows.
  const keep = { type: typeParam, status: statusParam };
  const lastPage = lastPageOf(total, state.rows);
  if (page > lastPage) redirect(listHref('/issues', keep, state, { page: lastPage }, { defaultRows: DEFAULT_ROWS }));
  // Sort and page size survive a change of type or status tab; the page does not.
  const listParams = stateParams(state, { defaultRows: DEFAULT_ROWS });
  const sorting = { basePath: '/issues', keep, state, defaultRows: DEFAULT_ROWS };
  const controls = { ...sorting, total, listKey: LIST_KEY, noun: 'issue' };

  const tabs: FilterTab[] = issueTabs(countsByType).map((tab) => ({
    value: tab.value,
    label: (
      <>
        {tab.label}
        <span className="ml-1.5 tabular-nums opacity-60">{formatNumber(tab.count)}</span>
      </>
    ),
  }));

  const counted = `${formatNumber(total)} ${pluralise(total, 'issue')}`;
  const noisy = countsByType[NOISY_TYPE] ?? 0;
  const subtitle =
    type === DEFAULT_TYPE && noisy > 0
      ? `${counted} needing a decision · ${formatNumber(noisy)} expected “no DRMS match” rows hidden`
      : counted;

  return (
    <>
      <PageHeader
        title="Link issues"
        subtitle={subtitle}
        actions={
          <FilterTabs
            basePath="/issues"
            param="status"
            current={status}
            tabs={STATUSES}
            defaultValue="open"
            ariaLabel="Filter issues by status"
            params={{ type: typeParam, ...listParams }}
          />
        }
      />

      <section className="rounded-xl border border-line bg-card">
        <div className="border-b border-line px-5 py-4">
          <FilterTabs
            basePath="/issues"
            param="type"
            current={type}
            tabs={tabs}
            defaultValue={DEFAULT_TYPE}
            ariaLabel="Filter issues by type"
            params={{ status: statusParam, ...listParams }}
          />
        </div>

        <ListControls {...controls} className="border-b border-line px-5 py-3.5" />

        <IssueTable
          rows={rows}
          emptyMessage={emptyMessage(type, status)}
          sorting={sorting}
          back={listHref('/issues', keep, state, {}, { defaultRows: DEFAULT_ROWS })}
        />

        <ListControls {...controls} position="bottom" className="border-t border-line px-5 py-3.5" />
      </section>
    </>
  );
}

/** An empty tab should read as an answer, not as a failure. */
function emptyMessage(type: string, status: Status): string {
  if (status === 'ignored') return 'No issues have been ignored.';
  if (status === 'resolved') return 'No issues have been resolved yet.';
  if (type === DEFAULT_TYPE) return 'Nothing needs a decision — every link issue is either resolved or expected.';
  if (type === NOISY_TYPE) return 'Every Vantage equipment record has a DRMS device.';
  return 'No issues of this type.';
}
