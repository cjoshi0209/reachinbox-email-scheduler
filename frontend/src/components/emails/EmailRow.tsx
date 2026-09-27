import Link from 'next/link';
import { formatListTime } from '@/lib/format';
import type { EmailListItem } from '@/lib/types';
import { StatusPill } from './StatusPill';

export type ListKind = 'scheduled' | 'sent';

export function EmailRow({ email, kind }: { email: EmailListItem; kind: ListKind }) {
  const doneAt = email.sentAt ?? email.failedAt;
  return (
    <li data-testid="email-row" data-status={email.status}>
      <Link
        href={`/emails/${email.id}`}
        className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 border-b border-line px-3 py-3.5 transition hover:bg-surface/70 md:grid-cols-[minmax(140px,220px)_auto_1fr_auto] md:px-4"
      >
        <span className="truncate text-sm" title={email.recipient}>
          <span className="text-muted">To: </span>
          <span data-testid="row-recipient">{email.recipient}</span>
        </span>

        <span className="justify-self-end md:justify-self-start">
          <StatusPill email={email} />
        </span>

        <span className="col-span-2 min-w-0 truncate text-sm md:col-span-1">
          <span className="font-semibold" data-testid="row-subject">
            {email.subject}
          </span>
          <span className="text-faint"> - {email.body.replace(/\s+/g, ' ')}</span>
        </span>

        <span className="hidden text-right text-xs text-muted md:block" data-testid="row-meta">
          {kind === 'sent' && doneAt ? (
            formatListTime(doneAt)
          ) : email.rescheduleCount > 0 ? (
            <span title="Moved by the hourly rate limit" className="text-warn-ink">
              Rescheduled
            </span>
          ) : (
            <span className="capitalize">{email.status}</span>
          )}
        </span>
      </Link>
    </li>
  );
}
