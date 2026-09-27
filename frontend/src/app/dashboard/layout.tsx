'use client';

import { Menu, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { Logo } from '@/components/icons';
import { Sidebar } from '@/components/layout/Sidebar';
import { IconButton } from '@/components/ui/Button';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  return (
    <RequireAuth>
      <div className="flex min-h-screen">
        <div className="sticky top-0 hidden h-screen w-64 shrink-0 md:block">
          <Sidebar />
        </div>

        {/* Mobile: top bar + slide-over sidebar */}
        {drawer && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div className="absolute inset-0 bg-black/30" onClick={() => setDrawer(false)} />
            <div className="relative h-full w-72 max-w-[85%] shadow-xl">
              <IconButton className="absolute right-3 top-4 z-10" onClick={() => setDrawer(false)} aria-label="Close menu">
                <X className="size-5" />
              </IconButton>
              <Sidebar onNavigate={() => setDrawer(false)} />
            </div>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b border-line px-4 py-3 md:hidden">
            <IconButton onClick={() => setDrawer(true)} aria-label="Open menu">
              <Menu className="size-5" />
            </IconButton>
            <Logo className="text-xl" />
          </div>
          <main className="flex-1 px-4 py-4 md:px-6 md:py-5">{children}</main>
        </div>
      </div>
    </RequireAuth>
  );
}
