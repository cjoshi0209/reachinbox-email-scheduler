'use client';

import { AlertCircle } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import useSWR from 'swr';
import { GoogleIdButton } from '@/components/auth/GoogleIdButton';
import { GoogleIcon } from '@/components/icons';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/Spinner';
import { fetcher } from '@/lib/api';
import { useUser } from '@/lib/hooks';
import type { Providers } from '@/lib/types';

const ERRORS: Record<string, string> = {
  google_not_configured: 'Google sign-in is not configured on the server yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).',
  invalid_state: 'Your sign-in session expired. Please try again.',
  google_auth_failed: 'Google sign-in failed. Please try again.',
  access_denied: 'Sign-in was cancelled.',
};

function LoginCard() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, mutate: refreshUser } = useUser();
  const { data: providers } = useSWR<Providers>('/api/auth/providers', fetcher);
  const [redirecting, setRedirecting] = useState(false);
  const [gisError, setGisError] = useState<string | null>(null);
  const errorCode = params.get('error');
  // Re-fetch the session first: the cached "not logged in" answer from this page would
  // otherwise bounce the dashboard straight back here.
  const onGisSuccess = useCallback(async () => {
    await refreshUser();
    router.replace('/dashboard');
  }, [refreshUser, router]);

  useEffect(() => {
    if (user) router.replace('/dashboard');
  }, [user, router]);

  const googleDisabled = providers?.google === false;

  return (
    <div className="w-full max-w-[440px] rounded-2xl border border-line bg-white px-8 py-10 shadow-sm sm:px-12">
      <h1 className="mb-8 text-center text-2xl font-semibold">Login</h1>

      {(errorCode || googleDisabled || gisError) && (
        <div role="alert" className="mb-5 flex gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{gisError ?? ERRORS[errorCode ?? ''] ?? (googleDisabled ? ERRORS.google_not_configured : 'Sign-in failed.')}</span>
        </div>
      )}

      {providers && !providers.googleRedirect && providers.googleClientId ? (
        // Host without the client secret: Google Identity Services (signed ID token).
        <GoogleIdButton clientId={providers.googleClientId} onSuccess={onGisSuccess} onError={setGisError} />
      ) : (
        <a
          href="/auth/google"
          onClick={() => setRedirecting(true)}
          aria-disabled={googleDisabled}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand-50 text-sm font-medium text-ink transition hover:bg-brand-100 aria-disabled:pointer-events-none aria-disabled:opacity-50"
        >
          {redirecting ? <Spinner className="size-4" /> : <GoogleIcon className="size-4" />}
          Login with Google
        </a>
      )}

      <div className="my-6 flex items-center gap-3 text-xs text-faint">
        <span className="h-px flex-1 bg-line" />
        or sign up through email
        <span className="h-px flex-1 bg-line" />
      </div>

      <form className="space-y-3" onSubmit={(e) => e.preventDefault()} aria-describedby="email-login-note">
        <Input type="email" placeholder="Email ID" disabled aria-label="Email ID" />
        <Input type="password" placeholder="Password" disabled aria-label="Password" />
        <button
          type="submit"
          disabled
          className="mt-2 h-11 w-full rounded-lg bg-brand-500 text-sm font-medium text-white opacity-60"
        >
          Login
        </button>
        <p id="email-login-note" className="pt-1 text-center text-xs text-faint">
          Email/password sign-in isn&apos;t enabled - please continue with Google.
        </p>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-4">
      <Suspense fallback={<Spinner />}>
        <LoginCard />
      </Suspense>
    </main>
  );
}
