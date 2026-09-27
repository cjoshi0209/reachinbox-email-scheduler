'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { toLocalInputValue } from '@/lib/format';

function tomorrowAt(hour?: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  if (hour !== undefined) d.setHours(hour, 0, 0, 0);
  return d;
}

const PRESETS: { label: string; get: () => Date }[] = [
  { label: 'Tomorrow', get: () => tomorrowAt() },
  { label: 'Tomorrow, 10:00 AM', get: () => tomorrowAt(10) },
  { label: 'Tomorrow, 11:00 AM', get: () => tomorrowAt(11) },
  { label: 'Tomorrow, 3:00 PM', get: () => tomorrowAt(15) },
];

/** Figma "Send Later" popover: date/time picker + quick presets, Cancel / Done. */
export function SendLaterPopover({ value, onDone, onCancel }: { value: Date | null; onDone: (d: Date | null) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(value ? toLocalInputValue(value) : '');
  const [error, setError] = useState('');

  function done() {
    if (!draft) return onDone(null);
    const d = new Date(draft);
    if (Number.isNaN(d.getTime())) return setError('Pick a valid date');
    if (d.getTime() < Date.now() - 60_000) return setError('Pick a time in the future');
    onDone(d);
  }

  return (
    <div role="dialog" aria-label="Send later" className="absolute right-0 top-full z-30 mt-2 w-72 rounded-xl border border-line bg-white p-4 shadow-xl">
      <p className="mb-3 text-sm font-medium">Send Later</p>
      <label className="flex items-center gap-2 border-b border-line pb-2">
        <input
          type="datetime-local"
          value={draft}
          min={toLocalInputValue(new Date())}
          onChange={(e) => {
            setDraft(e.target.value);
            setError('');
          }}
          aria-label="Pick date & time"
          data-testid="send-later-input"
          className="w-full bg-transparent text-sm outline-none"
        />
      </label>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      <ul className="mt-2">
        {PRESETS.map((p) => {
          const v = toLocalInputValue(p.get());
          return (
            <li key={p.label}>
              <button
                type="button"
                onClick={() => setDraft(v)}
                className={cn('w-full rounded-md px-1 py-1.5 text-left text-sm hover:bg-surface', draft === v && 'text-brand-600')}
              >
                {p.label}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={done}>
          Done
        </Button>
      </div>
    </div>
  );
}
