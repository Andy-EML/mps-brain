'use client';

import { useTransition } from 'react';
import { FastForward, Loader2, Play } from 'lucide-react';
import { toast } from 'sonner';
import { triggerAllJobsAction, triggerJobAction } from '@/app/(app)/admin/actions';
import { Button } from '@/components/ui/button';

export interface JobTriggerButtonProps {
  queue: string;
  /** Shown in the confirmation. Omitted for jobs that only touch Postgres. */
  confirm?: string;
}

/**
 * "Run now". A client component because the outcome needs saying: the job is *queued*, and whether
 * it then runs depends on the worker being up — a page that simply re-rendered would look like
 * nothing had happened.
 *
 * Jobs that call DRMS or Vantage ask first. pg-boss's `stately` policy already folds a second
 * click into the queued job, and the action says so when it does.
 */
export function JobTriggerButton({ queue, confirm }: JobTriggerButtonProps) {
  const [pending, start] = useTransition();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() => {
        if (confirm && !window.confirm(confirm)) return;
        start(async () => {
          const result = await triggerJobAction(queue);
          if (result.ok) toast.success(result.message);
          else toast.error(result.message);
        });
      }}
    >
      {pending ? <Loader2 aria-hidden className="animate-spin" /> : <Play aria-hidden />}
      {pending ? 'Queueing…' : 'Run now'}
    </Button>
  );
}

/** "Run all": queues every fetch and collection job (`RUN_ALL_QUEUES`). Always asks first. */
export function RunAllJobsButton({ confirm }: { confirm: string }) {
  const [pending, start] = useTransition();

  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() => {
        if (!window.confirm(confirm)) return;
        start(async () => {
          const result = await triggerAllJobsAction();
          if (result.ok) toast.success(result.message);
          else toast.error(result.message);
        });
      }}
    >
      {pending ? <Loader2 aria-hidden className="animate-spin" /> : <FastForward aria-hidden />}
      {pending ? 'Queueing…' : 'Run all'}
    </Button>
  );
}
