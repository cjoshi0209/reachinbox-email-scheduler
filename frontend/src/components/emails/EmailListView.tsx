'use client';

import { ChevronLeft, ChevronRight, ListFilter, RotateCw, Search } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { Button, IconButton } from '@/components/ui/Button';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/States';
import { useClickOutside } from '@/components/ui/useClickOutside';
import { fetcher } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { EmailListItem, EmailStatus, Paginated, SearchResponse } from '@/lib/types';
import { EmailRow, type ListKind } from './EmailRow';

const PAGE_SIZE = 25;

const CONFIG: Record<ListKind, { statuses: EmailStatus[]; empty: string; emptyHint: string }> = {
  scheduled: {
    statuses: ['scheduled', 'processing'],
    empty: 'No scheduled emails',
    emptyHint: 'Emails you schedule will wait here until they are sent.',
  },
  sent: {
    statuses: ['sent', 'failed'],
    empty: 'No sent emails yet',
    emptyHint: 'Delivered and failed emails will show up here.',
  },
};

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function EmailListView({ kind }: { kind: ListKind }) {
  const cfg = CONFIG[kind];
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<EmailStatus | 'all'>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const closeFilter = useCallback(() => setFilterOpen(false), []);
  useClickOutside(filterRef, closeFilter, filterOpen);

  const q = useDebounced(query.trim(), 300);
  useEffect(() => setPage(1), [q, statusFilter]);

  // Search (Elasticsearch) when there is a query or a status filter; plain list otherwise.
  const searching = q !== '' || statusFilter !== 'all';
  const statuses = statusFilter === 'all' ? cfg.statuses : [statusFilter];
  const key = searching
    ? `/api/emails/search?q=${encodeURIComponent(q)}&status=${statuses.join(',')}&limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}`
    : `/api/emails/${kind}?page=${page}&pageSize=${PAGE_SIZE}`;

  const { data, error, isLoading, isValidating, mutate } = useSWR<Paginated<EmailListItem> | SearchResponse>(key, fetcher, {
    refreshInterval: 5000,
    keepPreviousData: true,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  return (
    <section aria-label={kind === 'scheduled' ? 'Scheduled emails' : 'Sent emails'}>
      <div className="mb-3 flex items-center gap-2">
        <label className="flex h-10 flex-1 items-center gap-2 rounded-full bg-surface px-4">
          <Search className="size-4 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search emails"
            className="w-full bg-transparent text-sm outline-none placeholder:text-faint"
          />
        </label>

        <div ref={filterRef} className="relative">
          <IconButton
            aria-label="Filter by status"
            aria-expanded={filterOpen}
            onClick={() => setFilterOpen((o) => !o)}
            className={cn(statusFilter !== 'all' && 'bg-brand-50 text-brand-600')}
          >
            <ListFilter className="size-4" />
          </IconButton>
          {filterOpen && (
            <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-40 rounded-xl border border-line bg-white py-1 shadow-lg">
              {(['all', ...cfg.statuses] as const).map((s) => (
                <button
                  key={s}
                  role="menuitemradio"
                  aria-checked={statusFilter === s}
                  onClick={() => {
                    setStatusFilter(s);
                    setFilterOpen(false);
                  }}
                  className={cn('block w-full px-3 py-1.5 text-left text-sm capitalize hover:bg-surface', statusFilter === s && 'font-semibold text-brand-600')}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        <IconButton aria-label="Refresh" onClick={() => mutate()}>
          <RotateCw className={cn('size-4', isValidating && 'animate-spin')} />
        </IconButton>
      </div>

      {searching && data && 'source' in data && (
        <p className="mb-2 px-1 text-xs text-muted" data-testid="search-summary">
          {total} result{total === 1 ? '' : 's'}
          {q && <> for &ldquo;{q}&rdquo;</>}
          {data.source === 'postgres' && ' (search index unavailable - basic search)'}
        </p>
      )}

      {isLoading && !data ? (
        <ListSkeleton />
      ) : error && !data ? (
        <ErrorState message={error.message} onRetry={() => mutate()} />
      ) : items.length === 0 ? (
        searching ? (
          <EmptyState title="No matching emails" description="Try a different search term or filter." />
        ) : (
          <EmptyState
            title={cfg.empty}
            description={cfg.emptyHint}
            action={
              <Link href="/compose">
                <Button variant="outline">Compose new email</Button>
              </Link>
            }
          />
        )
      ) : (
        <>
          <ul className="border-t border-line" data-testid="email-list">
            {items.map((e) => (
              <EmailRow key={e.id} email={e} kind={kind} />
            ))}
          </ul>
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-end gap-2 pt-3 text-xs text-muted">
              <span>
                {from}-{to} of {total}
              </span>
              <IconButton aria-label="Previous page" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft className="size-4" />
              </IconButton>
              <IconButton aria-label="Next page" disabled={to >= total} onClick={() => setPage((p) => p + 1)}>
                <ChevronRight className="size-4" />
              </IconButton>
            </div>
          )}
        </>
      )}
    </section>
  );
}
