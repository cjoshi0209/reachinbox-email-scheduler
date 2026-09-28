'use client';

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';

interface GoogleIdApi {
  accounts: {
    id: {
      initialize(opts: { client_id: string; callback: (r: { credential: string }) => void; nonce: string; ux_mode: 'popup'; auto_select: boolean }): void;
      renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
    };
  };
}
declare global {
  interface Window {
    google?: GoogleIdApi;
  }
}

const GSI_SRC = 'https://accounts.google.com/gsi/client';

function loadGsi(): Promise<GoogleIdApi> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    const s = existing ?? Object.assign(document.createElement('script'), { src: GSI_SRC, async: true, defer: true });
    s.addEventListener('load', () => (window.google ? resolve(window.google) : reject(new Error('Google script missing'))));
    s.addEventListener('error', () => reject(new Error('Could not load Google sign-in')));
    if (!existing) document.head.appendChild(s);
  });
}

/**
 * "Sign in with Google" via Google Identity Services: Google returns a signed ID token
 * which the API verifies (signature, audience, expiry, one-time nonce). No client secret needed.
 */
export function GoogleIdButton({ clientId, onSuccess, onError }: { clientId: string; onSuccess: () => void | Promise<void>; onError: (m: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [gsi, { nonce }] = await Promise.all([loadGsi(), api.get<{ nonce: string }>('/api/auth/google/nonce')]);
        if (cancelled || !ref.current) return;
        gsi.accounts.id.initialize({
          client_id: clientId,
          nonce,
          ux_mode: 'popup',
          auto_select: false,
          callback: async ({ credential }) => {
            try {
              await api.post('/api/auth/google/token', { credential });
              await onSuccess();
            } catch (err) {
              onError(err instanceof ApiError ? err.message : 'Google sign-in failed');
            }
          },
        });
        gsi.accounts.id.renderButton(ref.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'signin_with',
          shape: 'rectangular',
          logo_alignment: 'center',
          width: 336,
        });
      } catch (err) {
        onError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId, onSuccess, onError]);

  return (
    <div className="flex min-h-11 w-full items-center justify-center" data-testid="google-id-button">
      {loading && <span className="text-xs text-muted">Loading Google sign-in…</span>}
      <div ref={ref} className="flex w-full justify-center" />
    </div>
  );
}
