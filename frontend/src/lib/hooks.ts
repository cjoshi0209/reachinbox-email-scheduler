'use client';

import useSWR from 'swr';
import { ApiError, fetcher } from './api';
import type { EmailStats, SendersResponse, SlackStatus, User } from './types';

export function useUser() {
  const { data, error, isLoading, mutate } = useSWR<User, ApiError>('/api/auth/me', fetcher, {
    shouldRetryOnError: (err: ApiError) => err.status !== 401,
    revalidateOnFocus: false,
  });
  return { user: data, isLoading, unauthenticated: error?.status === 401, error, mutate };
}

/** Live-ish counters for the sidebar; refreshed every 5s while the tab is visible. */
export function useStats() {
  return useSWR<EmailStats>('/api/emails/stats', fetcher, { refreshInterval: 5000 });
}

export function useSenders() {
  return useSWR<SendersResponse>('/api/senders', fetcher);
}

export function useSlackStatus() {
  return useSWR<SlackStatus>('/api/slack/status', fetcher);
}
