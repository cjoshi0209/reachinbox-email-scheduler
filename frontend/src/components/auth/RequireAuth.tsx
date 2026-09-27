'use client';

import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { FullPageSpinner } from '@/components/ui/Spinner';
import { ErrorState } from '@/components/ui/States';
import { useUser } from '@/lib/hooks';
import type { User } from '@/lib/types';

const UserContext = createContext<User | null>(null);

export function useCurrentUser(): User {
  const user = useContext(UserContext);
  if (!user) throw new Error('useCurrentUser must be used inside <RequireAuth>');
  return user;
}

/** Client-side guard: renders children only for a logged-in user, otherwise goes to /login. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading, unauthenticated, error, mutate } = useUser();
  const router = useRouter();

  useEffect(() => {
    if (unauthenticated) router.replace('/login');
  }, [unauthenticated, router]);

  if (isLoading || unauthenticated) return <FullPageSpinner />;
  if (error || !user) return <ErrorState message={error?.message ?? 'Could not load your account'} onRetry={() => mutate()} />;
  return <UserContext.Provider value={user}>{children}</UserContext.Provider>;
}
