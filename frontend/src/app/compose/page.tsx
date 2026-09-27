'use client';

import { ArrowLeft, Clock, Paperclip } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import { useSWRConfig } from 'swr';
import { RequireAuth, useCurrentUser } from '@/components/auth/RequireAuth';
import { RecipientsField, type RecipientsFieldHandle } from '@/components/compose/RecipientsField';
import { SendLaterPopover } from '@/components/compose/SendLaterPopover';
import { SenderSelect } from '@/components/compose/SenderSelect';
import { Button, IconButton } from '@/components/ui/Button';
import { BareInput, Textarea } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { useClickOutside } from '@/components/ui/useClickOutside';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatFull } from '@/lib/format';
import { useSenders } from '@/lib/hooks';
import type { ScheduleRequest, ScheduleResponse } from '@/lib/types';

function NumberBox({ id, value, onChange, placeholder, max }: { id: string; value: string; onChange: (v: string) => void; placeholder: string; max?: number }) {
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      min={0}
      max={max}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-20 rounded-lg border border-line px-2 text-sm outline-none focus:ring-2 focus:ring-brand-500/30"
    />
  );
}

function ComposeForm() {
  const user = useCurrentUser();
  const router = useRouter();
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const { data: senders } = useSenders();

  const [senderId, setSenderId] = useState('');
  const [recipients, setRecipients] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [delaySec, setDelaySec] = useState('');
  const [hourlyLimit, setHourlyLimit] = useState('');
  const [startAt, setStartAt] = useState<Date | null>(null);
  const [laterOpen, setLaterOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // One idempotency key per compose session: double clicks / retries can't double-schedule.
  const idempotencyKey = useRef(crypto.randomUUID());
  const recipientsRef = useRef<RecipientsFieldHandle>(null);
  const laterRef = useRef<HTMLDivElement>(null);
  const closeLater = useCallback(() => setLaterOpen(false), []);
  useClickOutside(laterRef, closeLater, laterOpen);

  const maxPerHour = senders?.maxPerHour;

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!senderId) e.sender = 'Choose or create a sender';
    if (recipients.length === 0) e.recipients = 'Add at least one recipient or upload a list';
    if (!subject.trim()) e.subject = 'Subject is required';
    if (!body.trim()) e.body = 'Write a message';
    const d = Number(delaySec || 0);
    if (!Number.isFinite(d) || d < 0 || d > 86_400) e.delay = 'Delay must be between 0 and 86400 seconds';
    if (hourlyLimit) {
      const h = Number(hourlyLimit);
      if (!Number.isInteger(h) || h < 1) e.hourly = 'Hourly limit must be a whole number above 0';
      else if (maxPerHour && h > maxPerHour) e.hourly = `Hourly limit cannot exceed the server cap of ${maxPerHour}`;
    }
    return e;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) {
      toast.error(Object.values(e)[0]!);
      return;
    }
    setSubmitting(true);
    try {
      const payload: ScheduleRequest = {
        senderId,
        subject: subject.trim(),
        body,
        recipients,
        delayMs: Math.round(Number(delaySec || 0) * 1000),
        ...(hourlyLimit ? { hourlyLimit: Number(hourlyLimit) } : {}),
        ...(startAt ? { startAt: startAt.toISOString() } : {}),
      };
      const res = await api.post<ScheduleResponse>('/api/emails/schedule', payload, { 'Idempotency-Key': idempotencyKey.current });
      toast.success(
        `${res.replayed ? 'Already scheduled' : 'Scheduled'} ${res.scheduled} email${res.scheduled === 1 ? '' : 's'}` +
          (res.duplicatesRemoved ? ` (${res.duplicatesRemoved} duplicate${res.duplicatesRemoved === 1 ? '' : 's'} removed)` : ''),
      );
      idempotencyKey.current = crypto.randomUUID();
      await mutate((key) => typeof key === 'string' && key.startsWith('/api/emails'));
      router.push('/dashboard');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not schedule emails');
    } finally {
      setSubmitting(false);
    }
  }

  const fieldError = (k: string) => errors[k] && <p className="pb-1 pl-[76px] text-xs text-red-600">{errors[k]}</p>;

  return (
    <form onSubmit={submit} className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-5 md:px-8">
      <header className="mb-6 flex items-center gap-3">
        <Link href="/dashboard" aria-label="Back to dashboard" className="rounded-full p-1 text-ink hover:bg-surface">
          <ArrowLeft className="size-5" />
        </Link>
        <h1 className="flex-1 text-lg font-medium md:text-xl">Compose New Email</h1>
        <IconButton type="button" aria-label="Upload recipient list" onClick={() => recipientsRef.current?.openFilePicker()}>
          <Paperclip className="size-4" />
        </IconButton>
        <div ref={laterRef} className="relative">
          <IconButton
            type="button"
            aria-label="Schedule for later"
            aria-expanded={laterOpen}
            onClick={() => setLaterOpen((o) => !o)}
            className={cn(startAt && 'text-brand-600')}
          >
            <Clock className="size-4" />
          </IconButton>
          {laterOpen && (
            <SendLaterPopover
              value={startAt}
              onCancel={() => setLaterOpen(false)}
              onDone={(d) => {
                setStartAt(d);
                setLaterOpen(false);
              }}
            />
          )}
        </div>
        <Button type="submit" variant="outline" size="sm" loading={submitting} data-testid="submit-schedule">
          {startAt ? 'Send Later' : 'Send'}
        </Button>
      </header>

      <div className="mx-auto w-full max-w-3xl">
        <SenderSelect value={senderId} onChange={setSenderId} defaultName={user.name} />
        {fieldError('sender')}

        <RecipientsField ref={recipientsRef} value={recipients} onChange={setRecipients} />
        {fieldError('recipients')}

        <label className="flex items-center gap-3 border-b border-line py-3">
          <span className="w-16 shrink-0 text-sm text-muted">Subject</span>
          <BareInput value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" maxLength={998} aria-label="Subject" />
        </label>
        {fieldError('subject')}

        <div className="flex flex-wrap items-center gap-x-8 gap-y-3 py-4">
          <label htmlFor="delay" className="flex items-center gap-3 text-sm text-ink">
            Delay between 2 emails
            <NumberBox id="delay" value={delaySec} onChange={setDelaySec} placeholder="00" />
            <span className="text-xs text-muted">sec</span>
          </label>
          <label htmlFor="hourly" className="flex items-center gap-3 text-sm text-ink">
            Hourly Limit
            <NumberBox id="hourly" value={hourlyLimit} onChange={setHourlyLimit} placeholder={maxPerHour ? String(maxPerHour) : '00'} max={maxPerHour} />
          </label>
        </div>
        {(errors.delay || errors.hourly) && <p className="-mt-2 pb-2 text-xs text-red-600">{errors.delay ?? errors.hourly}</p>}

        {startAt && (
          <p className="mb-3 flex items-center gap-2 rounded-lg bg-warn-bg px-3 py-2 text-xs text-warn-ink" data-testid="start-at">
            <Clock className="size-3.5" /> Sending starts {formatFull(startAt.toISOString())}
            <button type="button" className="ml-auto underline" onClick={() => setStartAt(null)}>
              Send now instead
            </button>
          </p>
        )}

        <div className="rounded-xl bg-surface p-4">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Type Your Reply..."
            rows={14}
            aria-label="Email body"
            maxLength={100_000}
          />
        </div>
        {errors.body && <p className="pt-1 text-xs text-red-600">{errors.body}</p>}
      </div>
    </form>
  );
}

export default function ComposePage() {
  return (
    <RequireAuth>
      <ComposeForm />
    </RequireAuth>
  );
}
