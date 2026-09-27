'use client';

import { Upload, X } from 'lucide-react';
import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import { useToast } from '@/components/ui/Toast';
import { parseLeads } from '@/lib/csv';

export interface RecipientsFieldHandle {
  openFilePicker: () => void;
}

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
}

const VISIBLE_CHIPS = 3;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Figma: "To" row with recipient chips, "+N" overflow and an "Upload List" action. */
export const RecipientsField = forwardRef<RecipientsFieldHandle, Props>(function RecipientsField({ value, onChange }, ref) {
  const [draft, setDraft] = useState('');
  const [upload, setUpload] = useState<{ file: string; detected: number; duplicates: number; invalid: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useImperativeHandle(ref, () => ({ openFilePicker: () => fileRef.current?.click() }));

  function merge(emails: string[]) {
    const seen = new Set(value);
    const added = emails.filter((e) => !seen.has(e) && (seen.add(e), true));
    onChange([...value, ...added]);
    return added.length;
  }

  function commitDraft() {
    if (!draft.trim()) return;
    const { emails, invalid } = parseLeads(draft);
    if (invalid.length) toast.error(`Not a valid email: ${invalid.join(', ')}`);
    merge(emails);
    setDraft('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      e.preventDefault();
      commitDraft();
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toast.error('File is too large (max 5 MB)');
      return;
    }
    const { emails, duplicates, invalid } = parseLeads(await file.text());
    if (emails.length === 0) {
      toast.error(`No email addresses found in ${file.name}`);
    } else {
      merge(emails);
      setUpload({ file: file.name, detected: emails.length, duplicates, invalid: invalid.length });
    }
    if (fileRef.current) fileRef.current.value = '';
  }

  const shown = expanded ? value : value.slice(0, VISIBLE_CHIPS);
  const hidden = value.length - shown.length;

  return (
    <div>
      <div className="flex items-start gap-3 border-b border-line py-3">
        <span className="w-16 shrink-0 pt-1 text-sm text-muted">To</span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" data-testid="recipient-chips">
          {shown.map((email) => (
            <span key={email} className="inline-flex items-center gap-1 rounded-full border border-brand-500/60 bg-white px-2 py-0.5 text-xs text-brand-700">
              {email}
              <button type="button" aria-label={`Remove ${email}`} onClick={() => onChange(value.filter((v) => v !== email))} className="text-brand-700/60 hover:text-brand-700">
                <X className="size-3" />
              </button>
            </span>
          ))}
          {hidden > 0 && (
            <button type="button" onClick={() => setExpanded(true)} className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
              +{hidden}
            </button>
          )}
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={commitDraft}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text');
              if (/[\s,;]/.test(text)) {
                e.preventDefault();
                merge(parseLeads(text).emails);
              }
            }}
            placeholder={value.length ? '' : 'recipient@example.com'}
            aria-label="Recipients"
            className="min-w-[160px] flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-faint"
          />
        </div>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex shrink-0 items-center gap-1.5 pt-1 text-xs font-medium text-brand-600 hover:text-brand-700"
        >
          <Upload className="size-3.5" /> Upload List
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          className="hidden"
          data-testid="csv-input"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </div>

      {(value.length > 0 || upload) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 pl-[76px] text-xs text-muted" data-testid="recipient-summary">
          <span>
            <span className="font-semibold text-ink" data-testid="recipient-count">
              {value.length}
            </span>{' '}
            recipient{value.length === 1 ? '' : 's'}
          </span>
          {upload && (
            <span data-testid="upload-summary">
              {upload.detected} email{upload.detected === 1 ? '' : 's'} detected in {upload.file}
              {upload.duplicates > 0 && `, ${upload.duplicates} duplicate${upload.duplicates === 1 ? '' : 's'} removed`}
              {upload.invalid > 0 && `, ${upload.invalid} invalid skipped`}
            </span>
          )}
          <button
            type="button"
            className="text-red-500 hover:underline"
            onClick={() => {
              onChange([]);
              setUpload(null);
              setExpanded(false);
            }}
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
});
