'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { SlackIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { api, ApiError } from '@/lib/api';
import { useSlackStatus } from '@/lib/hooks';

const CALLBACK_MESSAGES: Record<string, [kind: 'success' | 'error', message: string]> = {
  connected: ['success', 'Slack connected - you will be notified when a sender hits its hourly limit.'],
  denied: ['error', 'Slack connection was cancelled.'],
  error: ['error', 'Slack connection failed. Please try again.'],
  invalid_state: ['error', 'Slack connection expired. Please try again.'],
  not_configured: ['error', 'Slack is not configured on the server (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET).'],
};

export function SlackPanel() {
  const { data, isLoading, mutate } = useSlackStatus();
  const [busy, setBusy] = useState<'test' | 'disconnect' | null>(null);
  const toast = useToast();
  const params = useSearchParams();
  const shown = useRef(false);

  // Surface the result of the OAuth round-trip (?slack=connected|error...).
  useEffect(() => {
    const result = params.get('slack');
    if (!result || shown.current) return;
    shown.current = true;
    const [kind, message] = CALLBACK_MESSAGES[result] ?? ['error', 'Slack connection failed.'];
    toast[kind](message);
    void mutate();
    window.history.replaceState(null, '', window.location.pathname);
  }, [params, toast, mutate]);

  async function run(action: 'test' | 'disconnect') {
    setBusy(action);
    try {
      if (action === 'test') {
        await api.post('/api/slack/test');
        toast.success('Test message sent to Slack');
      } else {
        await api.delete('/api/slack/disconnect');
        toast.success('Slack disconnected');
        await mutate();
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-line p-3" data-testid="slack-panel">
      <div className="mb-2 flex items-center gap-2">
        <SlackIcon className="size-4" />
        <span className="text-xs font-semibold">Slack alerts</span>
      </div>
      {isLoading ? (
        <div className="h-8 animate-pulse rounded bg-surface" />
      ) : data?.connected ? (
        <>
          <p className="mb-2 text-[11px] leading-4 text-muted">
            Connected to <span className="font-medium text-ink">{data.teamName}</span>
            {data.channelName && <> &middot; {data.channelName}</>}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="soft" className="flex-1" loading={busy === 'test'} onClick={() => run('test')}>
              Test
            </Button>
            <Button size="sm" variant="danger" className="flex-1" loading={busy === 'disconnect'} onClick={() => run('disconnect')}>
              Disconnect
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="mb-2 text-[11px] leading-4 text-muted">Get notified when a sender reaches its hourly limit.</p>
          <a
            href="/auth/slack"
            aria-disabled={data?.configured === false}
            className="flex h-8 w-full items-center justify-center rounded-full border border-line text-xs font-medium transition hover:bg-surface aria-disabled:pointer-events-none aria-disabled:opacity-50"
          >
            Connect Slack
          </a>
          {data?.configured === false && <p className="mt-1.5 text-[10px] text-faint">Slack app not configured on server.</p>}
        </>
      )}
    </div>
  );
}
