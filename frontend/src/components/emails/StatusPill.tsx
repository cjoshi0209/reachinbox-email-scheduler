import { AlertCircle, Clock, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatListTime } from '@/lib/format';
import type { EmailListItem } from '@/lib/types';

const base = 'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap';

/** Figma: orange clock pill with the send time for scheduled; grey "Sent" pill for sent. */
export function StatusPill({ email }: { email: Pick<EmailListItem, 'status' | 'scheduledAt'> }) {
  switch (email.status) {
    case 'scheduled':
      return (
        <span className={cn(base, 'border-warn-line bg-warn-bg text-warn-ink')} title="Scheduled">
          <Clock className="size-3" />
          {formatListTime(email.scheduledAt)}
        </span>
      );
    case 'processing':
      return (
        <span className={cn(base, 'border-brand-100 bg-brand-50 text-brand-700')}>
          <Loader2 className="size-3 animate-spin" />
          Sending
        </span>
      );
    case 'sent':
      return <span className={cn(base, 'border-line bg-surface text-muted')}>Sent</span>;
    case 'failed':
      return (
        <span className={cn(base, 'border-red-200 bg-red-50 text-red-600')}>
          <AlertCircle className="size-3" />
          Failed
        </span>
      );
    case 'cancelled':
      return <span className={cn(base, 'border-line bg-white text-faint')}>Cancelled</span>;
  }
}
