import { listUsers, type AdminErrorCode } from '@mps/db/queries';
import { AddUserDialog } from '@/components/add-user-dialog';
import { AdminNav } from '@/components/admin-nav';
import { PageHeader } from '@/components/page-header';
import { UserTable } from '@/components/user-table';
import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber, pluralise } from '@/lib/format';

export const metadata = { title: 'Users · Admin · MPS Dashboard' };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `?error=` carries a code, never a sentence: the wording is looked up here, so a crafted link
 * cannot put arbitrary text into an error box on a page an admin trusts. An unknown code shows
 * nothing at all.
 */
const ERRORS: Partial<Record<AdminErrorCode | 'failed', string>> = {
  self_deactivate: 'You cannot deactivate your own account.',
  user_not_found: 'That user no longer exists.',
  failed: 'That change could not be saved. The details are in the server log.',
};

export default async function AdminUsersPage({ searchParams }: PageProps<'/admin/users'>) {
  // First statement, before anything else touches the request. The (app) layout's requireUser()
  // does not gate this page (Next fetches layout and page data in parallel), and it would only
  // check for *a* session anyway — an operator has one.
  const admin = await requireAdmin();
  const params = await searchParams;

  const error = ERRORS[first(params.error) as AdminErrorCode | 'failed'];

  const rows = await listUsers(getDb());
  const active = rows.filter((row) => row.active).length;
  const admins = rows.filter((row) => row.role === 'admin').length;

  return (
    <>
      <PageHeader
        title="Users"
        subtitle={`${formatNumber(rows.length)} ${pluralise(rows.length, 'account')} · ${formatNumber(
          active,
        )} active · ${formatNumber(admins)} ${pluralise(admins, 'admin')}`}
        actions={<AddUserDialog />}
      />

      <AdminNav current="users" />

      {error ? (
        <p role="alert" className="mt-5 rounded-xl bg-destructive/10 px-5 py-3.5 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <section className="mt-5 rounded-xl border border-line bg-card">
        <UserTable rows={rows} currentUserId={admin.userId} />
      </section>

      <p className="mt-4 max-w-3xl text-xs text-muted-foreground">
        Deactivating a user blocks them at sign-in and leaves everything they did on record. Nobody can
        deactivate their own account, so there is always at least one admin who can still get in.
      </p>
    </>
  );
}
