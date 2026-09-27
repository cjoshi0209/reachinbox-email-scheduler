export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string; details?: unknown };
  if (!res.ok) {
    let message = data.error ?? `Request failed (${res.status})`;
    if (Array.isArray(data.details) && data.details.length > 0) {
      const first = data.details[0] as { path?: string; message?: string };
      if (first.message) message = `${first.path ? `${first.path}: ` : ''}${first.message}`;
    }
    throw new ApiError(res.status, message, data.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/** SWR fetcher */
export const fetcher = <T>(path: string) => api.get<T>(path);
