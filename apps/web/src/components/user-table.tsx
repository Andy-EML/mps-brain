import { Power, PowerOff } from 'lucide-react';
import { cn } from 'cn';
import { setUserActiveAction } from '@/app/(app)/admin/actions';
import { ResetPasswordDialog } from '@/components/reset-password-dialog';
import { ToneBadge } from '@/components/tone-badge';
import { formatDate, formatRelative } from '@/lib/format';

export interface UserRow {
  id: number;
  username: string;
  role: string;
  active: boolean;
  createdAt: Date;
}

export interface UserTableProps {
  rows: UserRow[];
  /** The signed-in admin, so their own row can say "You" and hide the deactivate button. */
  currentUserId: number;
  now?: Date;
  className?: string;
}

const HEAD = 'px-5 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase';
const CELL = 'px-5 py-3.5 align-middle';
const ACTION =
  'inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[13px] whitespace-nowrap transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';

/**
 * The users table. A server component: only the two dialogs need the client. Activate and
 * deactivate are plain forms posting to a server action, so they work without JavaScript and the
 * feedback is the Status cell changing.
 */
export function UserTable({ rows, currentUserId, now = new Date(), className }: UserTableProps) {
  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full min-w-[760px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={cn(HEAD, 'w-[28%]')}>
              Username
            </th>
            <th scope="col" className={cn(HEAD, 'w-[14%]')}>
              Role
            </th>
            <th scope="col" className={cn(HEAD, 'w-[16%]')}>
              Status
            </th>
            <th scope="col" className={cn(HEAD, 'w-[18%]')}>
              Created
            </th>
            <th scope="col" className={cn(HEAD, 'w-[24%] text-right')}>
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isSelf = row.id === currentUserId;
            return (
              <tr key={row.id} className="border-b border-line last:border-b-0">
                <td className={CELL}>
                  <span className="font-medium">{row.username}</span>
                  {isSelf ? (
                    <span className="ml-2 rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand">
                      You
                    </span>
                  ) : null}
                </td>
                <td className={cn(CELL, 'capitalize')}>{row.role}</td>
                <td className={CELL}>
                  <ToneBadge tone={row.active ? 'ok' : 'muted'}>{row.active ? 'Active' : 'Deactivated'}</ToneBadge>
                </td>
                <td className={CELL}>
                  <span className="block text-[14px]">{formatDate(row.createdAt)}</span>
                  <span className="block text-xs text-muted-foreground">{formatRelative(row.createdAt, now)}</span>
                </td>
                <td className={cn(CELL, 'text-right')}>
                  <div className="flex items-center justify-end gap-2">
                    <ResetPasswordDialog userId={row.id} username={row.username} isSelf={isSelf} />
                    {isSelf ? (
                      // Not merely hidden: `setUserActive` refuses it too, with the actor id taken
                      // from the session rather than from this form.
                      <span className="text-xs text-muted-foreground">Can’t deactivate yourself</span>
                    ) : (
                      <form action={setUserActiveAction}>
                        <input type="hidden" name="userId" value={row.id} />
                        <input type="hidden" name="active" value={row.active ? 'false' : 'true'} />
                        <button type="submit" className={ACTION}>
                          {row.active ? <PowerOff aria-hidden className="size-3.5" /> : <Power aria-hidden className="size-3.5" />}
                          {row.active ? 'Deactivate' : 'Activate'}
                        </button>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
