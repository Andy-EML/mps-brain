import type { PmStatus } from '@mps/db/queries';

/** PM statuses, client-safe: type-only import from @mps/db, so client components can use it. */
export const PM_STATUSES = ['overdue', 'due_soon', 'held', 'booked', 'unknown', 'ok'] as const satisfies readonly PmStatus[];
