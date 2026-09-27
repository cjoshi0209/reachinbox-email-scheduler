'use client';

import { ChevronDown, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useClickOutside } from '@/components/ui/useClickOutside';
import { api, ApiError } from '@/lib/api';
import { useSenders } from '@/lib/hooks';
import type { Sender } from '@/lib/types';

export function SenderSelect({ value, onChange, defaultName }: { value: string; onChange: (id: string) => void; defaultName: string }) {
  const { data, isLoading, error, mutate } = useSenders();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close, open);

  const senders = data?.items ?? [];
  const selected = senders.find((s) => s.id === value);

  // Default to the first sender once loaded.
  const firstId = data?.items[0]?.id;
  useEffect(() => {
    if (!value && firstId) onChange(firstId);
  }, [value, firstId, onChange]);

  return (
    <div className="flex items-center gap-3 py-3">
      <span className="w-16 shrink-0 text-sm text-muted">From</span>
      <div ref={ref} className="relative">
        <button
          type="button"
          onClick={() => (senders.length ? setOpen((o) => !o) : setCreating(true))}
          aria-haspopup="listbox"
          aria-expanded={open}
          data-testid="sender-select"
          className="flex h-8 items-center gap-2 rounded-lg bg-surface px-3 text-sm hover:bg-line"
        >
          {isLoading ? 'Loading senders...' : error ? 'Could not load senders' : selected ? selected.email : 'Add a sender'}
          <ChevronDown className="size-4 text-faint" />
        </button>
        {open && (
          <ul role="listbox" className="absolute left-0 top-full z-20 mt-1 min-w-72 rounded-xl border border-line bg-white py-1 shadow-lg">
            {senders.map((s: Sender) => (
              <li key={s.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={s.id === value}
                  onClick={() => {
                    onChange(s.id);
                    setOpen(false);
                  }}
                  className="flex w-full flex-col px-3 py-2 text-left hover:bg-surface"
                >
                  <span className="text-sm">{s.email}</span>
                  <span className="text-[11px] text-muted">
                    {s.name} &middot; {s.sentThisHour ?? 0}/{data?.maxPerHour} sent this hour
                  </span>
                </button>
              </li>
            ))}
            <li className="border-t border-line">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setCreating(true);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-brand-600 hover:bg-brand-50"
              >
                <Plus className="size-4" /> New Ethereal sender
              </button>
            </li>
          </ul>
        )}
      </div>

      <CreateSenderModal
        open={creating}
        defaultName={defaultName}
        onClose={() => setCreating(false)}
        onCreated={async (s) => {
          await mutate();
          onChange(s.id);
          setCreating(false);
        }}
      />
    </div>
  );
}

function CreateSenderModal({
  open,
  defaultName,
  onClose,
  onCreated,
}: {
  open: boolean;
  defaultName: string;
  onClose: () => void;
  onCreated: (s: Sender) => void | Promise<void>;
}) {
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit(e: FormEvent) {
    e.preventDefault();
    // React bubbles submit through portals to the page's compose form; keep it here.
    e.stopPropagation();
    setBusy(true);
    try {
      const sender = await api.post<Sender>('/api/senders', { name: name.trim() || defaultName });
      toast.success(`Sender ${sender.email} created`);
      await onCreated(sender);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create sender');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="New Ethereal sender" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">
          A fresh Ethereal SMTP inbox is created for this sender. Mail is captured by Ethereal (never delivered), and each sent email gets a preview link.
        </p>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Display name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Create sender
          </Button>
        </div>
      </form>
    </Modal>
  );
}
