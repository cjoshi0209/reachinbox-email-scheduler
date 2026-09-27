'use client';

import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { StatusPill } from '@/components/emails/StatusPill';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { FullPageSpinner } from '@/components/ui/Spinner';
import { ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { api, ApiError, fetcher } from '@/lib/api';
import { formatFull } from '@/lib/format';
import type { EmailDetail } from '@/lib/types';

function Detail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<EmailDetail, ApiError>(`/api/emails/${id}`, fetcher, { refreshInterval: 5000 });

  if (isLoading) return <FullPageSpinner />;
  if (error || !data) return <ErrorState message={error?.message ?? 'Email not found'} onRetry={() => mutate()} />;

  async function cancel() {
    setCancelling(true);
    try {
      await api.post(`/api/emails/${id}/cancel`);
      toast.success('Email cancelled');
      await mutate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not cancel');
    } finally {
      setCancelling(false);
    }
  }

  const facts: [string, string][] = [
    ['Status', data.status],
    ['Scheduled for', formatFull(data.scheduledAt)],
    ...(data.rescheduleCount > 0 ? ([['Originally scheduled', formatFull(data.originalScheduledAt)]] as [string, string][]) : []),
    ['Sent at', formatFull(data.sentAt)],
    ...(data.failedAt ? ([['Failed at', formatFull(data.failedAt)]] as [string, string][]) : []),
    ['Attempts', String(data.attempts)],
    ['Rescheduled by rate limit', `${data.rescheduleCount} time${data.rescheduleCount === 1 ? '' : 's'}`],
    ['Campaign', `${data.campaign.totalEmails} emails · ${data.campaign.delayMs / 1000}s apart · max ${data.campaign.hourlyLimit}/hour`],
  ];

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-5 md:px-8">
      <header className="mb-6 flex items-center gap-3">
        <button onClick={() => router.back()} aria-label="Back" className="rounded-full p-1 hover:bg-surface">
          <ArrowLeft className="size-5" />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-medium md:text-xl">{data.subject}</h1>
        <StatusPill email={data} />
      </header>

      <article className="md:pl-10">
        <div className="mb-6 flex items-start gap-3">
          <Avatar name={data.sender.name} />
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              <span className="font-semibold">{data.sender.name}</span> <span className="text-muted">&lt;{data.sender.email}&gt;</span>
            </p>
            <p className="text-xs text-muted">to {data.recipient}</p>
          </div>
          <span className="shrink-0 text-xs text-muted">{formatFull(data.sentAt ?? data.scheduledAt)}</span>
        </div>

        <div className="whitespace-pre-wrap text-sm leading-6">{data.body}</div>

        {data.error && (
          <p className="mt-6 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
            {data.error}
          </p>
        )}

        <dl className="mt-8 grid gap-x-6 gap-y-2 rounded-xl border border-line p-4 text-sm sm:grid-cols-[200px_1fr]">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="first-letter:uppercase">{v}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-6 flex flex-wrap gap-2">
          {data.previewUrl && (
            <a href={data.previewUrl} target="_blank" rel="noreferrer">
              <Button variant="outline" size="sm">
                <ExternalLink className="size-3.5" /> Open in Ethereal
              </Button>
            </a>
          )}
          {data.status === 'scheduled' && (
            <Button variant="danger" size="sm" loading={cancelling} onClick={cancel}>
              Cancel email
            </Button>
          )}
        </div>
      </article>
    </div>
  );
}

export default function EmailDetailPage() {
  return (
    <RequireAuth>
      <Detail />
    </RequireAuth>
  );
}
