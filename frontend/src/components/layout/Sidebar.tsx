'use client';

import { Clock, Send } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense } from 'react';
import { Logo } from '@/components/icons';
import { cn } from '@/lib/cn';
import { useStats } from '@/lib/hooks';
import { SlackPanel } from './SlackPanel';
import { UserMenu } from './UserMenu';

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { data: stats } = useStats();

  const items = [
    { href: '/dashboard', label: 'Scheduled', icon: Clock, count: stats?.upcoming },
    { href: '/dashboard/sent', label: 'Sent', icon: Send, count: stats?.delivered },
  ];

  return (
    <aside className="flex h-full w-full flex-col gap-4 bg-white px-4 py-5">
      <Logo className="px-1" />
      <UserMenu />
      <Link
        href="/compose"
        onClick={onNavigate}
        className="flex h-10 items-center justify-center rounded-full border border-brand-500 text-sm font-medium text-brand-600 transition hover:bg-brand-50"
      >
        Compose
      </Link>

      <nav aria-label="Mailboxes">
        <p className="mb-1.5 px-2 text-[11px] font-medium uppercase tracking-wide text-faint">Core</p>
        <ul className="space-y-1">
          {items.map(({ href, label, icon: Icon, count }) => {
            const active = pathname === href;
            return (
              <li key={href}>
                <Link
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition',
                    active ? 'bg-brand-50 font-semibold text-ink' : 'text-ink/80 hover:bg-surface',
                  )}
                >
                  <Icon className="size-4" />
                  <span className="flex-1">{label}</span>
                  <span className="text-xs font-normal text-muted" data-testid={`count-${label.toLowerCase()}`}>
                    {count ?? ''}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="mt-auto">
        <Suspense>
          <SlackPanel />
        </Suspense>
      </div>
    </aside>
  );
}
