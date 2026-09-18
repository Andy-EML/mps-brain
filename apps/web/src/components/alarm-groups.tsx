import { cn } from 'cn';
import { alarmCode, alarmStatusLabel, type AlarmGroup } from '@/components/device-detail';
import { ToneBadge } from '@/components/tone-badge';
import type { Tone } from '@/components/toner';
import { formatDateTime, pluralise } from '@/lib/format';

/**
 * DRMS only forwards an alarm to the ERP when its status reaches `ReadyForErpDelivery`; everything
 * else is DRMS telling us why it did not. That one status is therefore the only actionable one and
 * the only one that gets a colour.
 */
function statusTone(status: string | null): Tone {
  return status === 'ReadyForErpDelivery' ? 'warn' : 'muted';
}

const HEAD = 'px-5 py-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase';

export interface AlarmGroupsProps {
  groups: AlarmGroup[];
  className?: string;
}

/** The "Consumables & alarms" card body: one block per category, newest alarm first. */
export function AlarmGroups({ groups, className }: AlarmGroupsProps) {
  return (
    <div className={className}>
      {groups.map((group) => (
        <div key={group.key} className="border-t border-line first:border-t-0">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-5 pt-4 pb-1">
            <h3 className="text-[14px] font-medium">
              {group.label}
              <span className="ml-2 text-[13px] font-normal text-muted-foreground">
                {group.rows.length} {pluralise(group.rows.length, 'alarm')}
              </span>
            </h3>
            <p className="text-[12px] text-muted-foreground">{group.hint}</p>
          </div>

          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse text-left">
              <thead className="sr-only">
                <tr>
                  <th scope="col" className={HEAD}>
                    Code
                  </th>
                  <th scope="col" className={HEAD}>
                    Description
                  </th>
                  <th scope="col" className={HEAD}>
                    Received
                  </th>
                  <th scope="col" className={HEAD}>
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.alarmId} className="border-t border-line/70">
                    <td className="px-5 py-2.5 font-mono text-[12px] whitespace-nowrap">{alarmCode(row)}</td>
                    <td className="px-5 py-2.5 text-[14px]">{row.description ?? '—'}</td>
                    <td className={cn('px-5 py-2.5 text-[13px] whitespace-nowrap text-muted-foreground tabular')}>
                      {formatDateTime(row.receivedTime)}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <ToneBadge tone={statusTone(row.status)} dot={false} className="text-[12px]">
                        {alarmStatusLabel(row.status)}
                      </ToneBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
