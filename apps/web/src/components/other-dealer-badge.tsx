// Types only from @mps/db: this badge renders inside client components too.
import type { OtherDealerInfo } from '@mps/db/queries';
import { ToneBadge } from '@/components/tone-badge';
import { otherDealerBadgeText } from '@/lib/other-dealer-form';

/**
 * "Other dealer: MJ Flood" (with "(head office)" / "(by region)" when not set on the site itself)
 * for a customer another dealer services for PM. Renders nothing when we service it. PM only: the
 * site's toner, alerts and devices are unaffected.
 */
export function OtherDealerBadge({ info, className }: { info: Pick<OtherDealerInfo, 'dealer' | 'source'>; className?: string }) {
  const text = otherDealerBadgeText(info);
  if (text === null) return null;
  return (
    <ToneBadge tone="muted" dot={false} className={className}>
      {text}
    </ToneBadge>
  );
}
