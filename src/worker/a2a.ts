/**
 * A2A client (JSON-RPC 2.0 over HTTPS, streaming over SSE).
 *
 * Every call takes an AgentCredential = { rpcUrl, token, label }; src/connect.ts is
 * where those come from. This layer only speaks the protocol.
 *
 * A chat turn uses `message/stream`: one POST whose response is a text/event-stream
 * of JSON-RPC envelopes. The accumulator below folds those events into a snapshot
 * (full text so far, task state, ids), so callers never deal with append/lastChunk
 * artifact semantics themselves.
 *
 * Connectivity checks use `tasks/get` with an id that cannot exist — never
 * `message/send` — so verifying N agents never bills N turns.
 */

import type { AgentCredential } from './types';

const PROBE_TIMEOUT_MS = 20_000;
const CARD_TIMEOUT_MS = 10_000;
const ERROR_TEXT_LIMIT = 600;

export class A2AError extends Error {
  // Plain fields rather than constructor parameter properties: keeps the class
  // friendly to any TS toolchain that only strips types.
  readonly retryable: boolean;
  readonly refreshCredential: boolean;

  constructor(message: string, retryable: boolean, refreshCredential = false) {
    super(safeErrorText(message));
    this.name = 'A2AError';
    this.retryable = retryable;
    this.refreshCredential = refreshCredential;
  }
}

/** Strips anything token-shaped before an error string can reach a log or the browser. */
export function safeErrorText(value: unknown): string {
  return String(value ?? '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-token]')
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, ERROR_TEXT_LIMIT);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function looksTransient(message: string): boolean {
  return /\b(timeout|timed out|temporar|unavailable|overload|rate limit|too many|network|fetch failed|connection|socket|internal error|server error|502|503|504)\b/i.test(
    message,
  );
}

export async function fetchTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    const message = safeErrorText(error instanceof Error ? error.message : error);
    const aborted = /abort|timeout/i.test(message) || (error as Error)?.name === 'AbortError';
    throw new A2AError(aborted ? `Request timed out. ${message}` : message, true);
  } finally {
    clearTimeout(timer);
  }
}

/** A URL handed back by Manyfold is still untrusted input; reject anything internal. */
export function validateA2AUrl(raw: string, production: boolean, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new A2AError(`${label} is not a valid URL.`, false);
  }
  if (url.username || url.password) {
    throw new A2AError(`${label} must not carry credentials in the URL.`, false);
  }
  if (url.protocol !== 'https:' && !(!production && url.protocol === 'http:')) {
    throw new A2AError(`${label} must use https.`, false);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const blocked =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/i.test(host) ||
    /^fe[89ab][0-9a-f]:/i.test(host);
  if (blocked && production) throw new A2AError(`${label} points at a private address.`, false);
  url.hash = '';
  return url.toString();
}

/* ───────── JSON-RPC ───────── */

function rpcBody(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', method, id: crypto.randomUUID(), params });
}

function jsonRpcError(value: unknown, label: string): A2AError {
  const error = (value ?? {}) as Record<string, unknown>;
  const code = typeof error.code === 'number' ? error.code : undefined;
  const message = safeErrorText(error.message ?? error.data ?? JSON.stringify(error));
  // -32700/-32600/-32601/-32602 mean we sent something wrong; retrying sends it again.
  const permanent = code === -32700 || code === -32600 || code === -32601 || code === -32602;
  return new A2AError(
    `${label} RPC error${code === undefined ? '' : ` ${code}`}: ${message}`,
    !permanent && looksTransient(message),
  );
}

async function httpFailure(response: Response, label: string): Promise<A2AError> {
  const detail = safeErrorText(await response.text());
  return new A2AError(
    `${label} failed: HTTP ${response.status}${detail ? ` · ${detail}` : ''}`,
    retryableStatus(response.status) || response.status === 401,
    response.status === 401,
  );
}

/**
 * Connectivity probe: ask for a task id that cannot exist.
 *
 * Deliberately not `message/send` — that would run a real turn, so connecting N agents
 * would bill N turns. Only the auth answer matters: 401/403 means the token is rejected;
 * anything else (including a JSON-RPC "no such task" error) means token and endpoint work.
 */
export async function probeAgentAuth(cred: AgentCredential): Promise<void> {
  const response = await fetchTimeout(
    cred.rpcUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.token}` },
      body: rpcBody('tasks/get', { id: `probe-${crypto.randomUUID()}` }),
      redirect: 'manual',
    },
    PROBE_TIMEOUT_MS,
  );
  if (response.status === 401 || response.status === 403) {
    throw new A2AError(`${cred.label} rejected this token (HTTP ${response.status}).`, false, true);
  }
  if (!response.ok && response.status >= 500) {
    throw new A2AError(`${cred.label} is temporarily unavailable (HTTP ${response.status}).`, true);
  }
}

/** Best-effort agent-card read for a description; cards are public, so no bearer is sent. */
export async function describeFromCard(cardUrl: string): Promise<string> {
  try {
    const response = await fetchTimeout(
      cardUrl,
      { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual' },
      CARD_TIMEOUT_MS,
    );
    if (!response.ok) return '';
    const card = (await response.json()) as Record<string, unknown>;
    return typeof card.description === 'string' ? card.description.slice(0, 240) : '';
  } catch {
    return '';
  }
}

/* ───────── streaming ───────── */

export const TERMINAL_STATES = new Set([
  'completed',
  'failed',
  'canceled',
  'rejected',
  'input-required',
  'auth-required',
]);

export interface StreamSnapshot {
  taskId: string | null;
  contextId: string | null;
  state: string;
  /** Full reply text accumulated so far. */
  text: string;
  /** Progress text from status.message, when it differs from the reply itself. */
  progressText: string;
  terminal: boolean;
}

interface StreamAccumulator {
  taskId: string | null;
  contextId: string | null;
  state: string;
  artifacts: Map<string, string>;
  order: string[];
  directText: string;
  statusText: string;
}

export function createAccumulator(): StreamAccumulator {
  return {
    taskId: null,
    contextId: null,
    state: '',
    artifacts: new Map(),
    order: [],
    directText: '',
    statusText: '',
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function partsText(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  return raw
    .map((part) =>
      part && typeof part === 'object' && typeof (part as any).text === 'string'
        ? ((part as any).text as string)
        : '',
    )
    .filter(Boolean)
    .join('\n');
}

export function normalizeState(value: unknown): string {
  const raw = String(value ?? '')
    .toLowerCase()
    .replace(/^task_state_/, '')
    .replace(/_/g, '-');
  return [
    'submitted',
    'working',
    'completed',
    'failed',
    'canceled',
    'rejected',
    'input-required',
    'auth-required',
  ].includes(raw)
    ? raw
    : '';
}

/** Folds one JSON-RPC `result` (task, message, status-update or artifact-update) in. */
export function applyA2AResult(accumulator: StreamAccumulator, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as Record<string, unknown>;
  const kind = String(value.kind ?? '').toLowerCase();
  const taskId = stringValue(value.taskId) ?? stringValue(value.id);
  const contextId = stringValue(value.contextId);
  if (taskId) accumulator.taskId = taskId;
  if (contextId) accumulator.contextId = contextId;

  if (kind === 'artifact-update' || value.artifact) {
    const artifact = (value.artifact ?? {}) as Record<string, unknown>;
    const id = stringValue(artifact.artifactId) ?? stringValue(artifact.id) ?? 'artifact';
    const text = partsText(artifact.parts);
    if (!accumulator.order.includes(id)) accumulator.order.push(id);
    accumulator.artifacts.set(
      id,
      value.append ? `${accumulator.artifacts.get(id) ?? ''}${text}` : text,
    );
  }

  if (kind === 'message' || (value.role && value.parts)) {
    accumulator.directText = partsText(value.parts) || accumulator.directText;
  }

  const status = (value.status ?? {}) as Record<string, unknown>;
  const state = normalizeState(status.state ?? value.state);
  if (state) accumulator.state = state;
  const statusMessage = status.message as Record<string, unknown> | undefined;
  if (statusMessage) {
    accumulator.statusText = partsText(statusMessage.parts) || accumulator.statusText;
  }

  // A full task object may carry finished artifacts inline.
  const artifacts = value.artifacts as Array<Record<string, unknown>> | undefined;
  for (const artifact of artifacts ?? []) {
    const id = stringValue(artifact.artifactId) ?? stringValue(artifact.id) ?? crypto.randomUUID();
    if (!accumulator.order.includes(id)) accumulator.order.push(id);
    accumulator.artifacts.set(id, partsText(artifact.parts));
  }
}

export function snapshotFrom(accumulator: StreamAccumulator): StreamSnapshot {
  const artifactText = accumulator.order
    .map((id) => accumulator.artifacts.get(id) ?? '')
    .filter(Boolean)
    .join('\n\n');
  const text = artifactText || accumulator.directText || accumulator.statusText;
  return {
    taskId: accumulator.taskId,
    contextId: accumulator.contextId,
    state: accumulator.state,
    text,
    // Suppressed when it is itself the answer, so the UI never shows the same
    // sentence twice — once as progress and once as the reply.
    progressText: text === accumulator.statusText ? '' : accumulator.statusText,
    terminal: TERMINAL_STATES.has(accumulator.state),
  };
}

/** Test/dev helper: fold a sequence of JSON-RPC results into one snapshot. */
export function foldA2AResults(results: unknown[]): StreamSnapshot {
  const accumulator = createAccumulator();
  for (const result of results) applyA2AResult(accumulator, result);
  return snapshotFrom(accumulator);
}

/**
 * One `message/stream` turn. Emits a snapshot after every SSE event and resolves with
 * the final one. Requires the endpoint to answer with text/event-stream — there is no
 * `message/send` fallback, by design: Manyfold agents stream, and one protocol path
 * keeps this template small.
 */
export async function consumeA2AStream(options: {
  cred: AgentCredential;
  params: Record<string, unknown>;
  signal: AbortSignal;
  onSnapshot?: (snapshot: StreamSnapshot) => Promise<void> | void;
}): Promise<StreamSnapshot> {
  const { cred } = options;
  let response: Response;
  try {
    response = await fetch(cred.rpcUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${cred.token}`,
      },
      redirect: 'manual',
      signal: options.signal,
      body: rpcBody('message/stream', options.params),
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new A2AError(`${cred.label} stream timed out.`, true);
    }
    throw new A2AError(safeErrorText(error instanceof Error ? error.message : error), true);
  }
  if (!response.ok) throw await httpFailure(response, cred.label);
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
    throw new A2AError(`${cred.label} does not support A2A streaming (message/stream).`, false);
  }
  if (!response.body) throw new A2AError(`${cred.label} streaming response had no body.`, true);

  const accumulator = createAccumulator();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let received = false;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') {
          throw new A2AError(`${cred.label} stream timed out.`, true);
        }
        throw error;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data && data !== '[DONE]') {
          let envelope: Record<string, unknown>;
          try {
            envelope = JSON.parse(data) as Record<string, unknown>;
          } catch {
            throw new A2AError(`${cred.label} stream emitted invalid JSON.`, true);
          }
          if (envelope.error) throw jsonRpcError(envelope.error, cred.label);
          applyA2AResult(accumulator, envelope.result);
          received = true;
          const snapshot = snapshotFrom(accumulator);
          await options.onSnapshot?.(snapshot);
          if (snapshot.terminal) return snapshot;
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!received) throw new A2AError(`${cred.label} stream ended without events.`, true);
  return snapshotFrom(accumulator);
}
