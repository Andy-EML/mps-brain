import Link from 'next/link';
import type { SelfManagedSource } from '@mps/db/queries';
import { cn } from 'cn';
import { customerHref, customerStockBadge } from '@/components/customers';
import { ToneBadge } from '@/components/tone-badge';

export interface SelfManagedBadgeProps {
  /** Where the flag comes from; nothing renders when null (the customer is not self-managed). */
  source: SelfManagedSource | null;
  /** The customer whose page the badge opens; without one the badge is plain text. */
  vantageCustomerId: number | null;
  /** `sm` for table rows, beside the customer name; default size beside a page title. */
  size?: 'sm' | 'default';
  className?: string;
}

/**
 * "Self-managed" / "Self-managed via head office": the customer keeps its own toner, so the app
 * proposes none for this device. Same wording and tone as the Customers list's Stock column
 * (`customerStockBadge`), and a link to the customer page, where the switch lives.
 */
export function SelfManagedBadge({ source, vantageCustomerId, size = 'default', className }: SelfManagedBadgeProps) {
  if (source === null) return null;
  const { text, tone } = customerStockBadge(source);
  const badge = (
    <ToneBadge tone={tone} dot={size === 'default'} className={cn(size === 'sm' && 'px-2 py-0.5 text-[11px]', className)}>
      {text}
    </ToneBadge>
  );
  if (vantageCustomerId === null) return badge;
  return (
    <Link
      href={customerHref(vantageCustomerId)}
      title="Customer manages its own stock: open the customer"
      className="inline-flex rounded-full outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-brand/50"
    >
      {badge}
    </Link>
  );
}
