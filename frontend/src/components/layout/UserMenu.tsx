'use client';

import { ChevronDown, ExternalLink, LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { useCurrentUser } from '@/components/auth/RequireAuth';
import { Avatar } from '@/components/ui/Avatar';
import { useToast } from '@/components/ui/Toast';
import { useClickOutside } from '@/components/ui/useClickOutside';
import { api } from '@/lib/api';

export function UserMenu() {
  const user = useCurrentUser();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close, open);
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const toast = useToast();

  async function logout() {
    try {
      await api.post('/auth/logout');
      await mutate(() => true, undefined, { revalidate: false });
      router.replace('/login');
    } catch {
      toast.error('Logout failed, please try again');
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="user-menu"
        className="flex w-full items-center gap-2.5 rounded-xl bg-surface px-3 py-2.5 text-left transition hover:bg-line"
      >
        <Avatar name={user.name} src={user.avatarUrl} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium" data-testid="user-name">
            {user.name}
          </span>
          <span className="block truncate text-[11px] text-muted" data-testid="user-email">
            {user.email}
          </span>
        </span>
        <ChevronDown className={`size-4 shrink-0 text-faint transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div role="menu" className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-line bg-white py-1 shadow-lg">
          <a
            role="menuitem"
            href="/admin/queues"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface"
          >
            <ExternalLink className="size-4 text-muted" /> Queue dashboard
          </a>
          <button role="menuitem" onClick={logout} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50">
            <LogOut className="size-4" /> Logout
          </button>
        </div>
      )}
    </div>
  );
}
