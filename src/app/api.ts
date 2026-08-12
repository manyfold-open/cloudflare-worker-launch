/**
 * Fetch wrapper for the app's own API.
 *
 * Authentication is a session cookie the Worker sets and reads; the browser holds no
 * credential of its own, which is the point — the user's Manyfold token never reaches
 * this side. `credentials: 'same-origin'` is explicit rather than relied upon, so a
 * future fetch-default change cannot silently drop the cookie.
 */

import type { ApiErrorBody } from '../shared/types';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      /* not JSON */
    }
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'request_failed',
      body?.error?.message ?? `Request failed with HTTP ${response.status}.`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const post = <T>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const del = <T>(path: string): Promise<T> => api<T>(path, { method: 'DELETE' });
