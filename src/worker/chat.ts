/**
 * One chat turn: browser → this Worker → agent (A2A message/stream) → browser (SSE).
 *
 * The Worker sits in the middle for two reasons: the bearer token must never reach
 * the browser, and the reply must be persisted even if the user closes the tab
 * mid-stream. The response stream is returned immediately; the pump keeps running
 * under waitUntil, so a client disconnect aborts nothing upstream — writes to the
 * gone client fail silently while consumption and persistence continue.
 *
 * Events sent to the browser are app-level (see ChatEvent in src/shared/types.ts):
 * `text` always carries the full accumulated reply, so the client just replaces its
 * buffer and all artifact append/lastChunk semantics stay server-side.
 */

import type { ChatEvent, ChatMessage, ConversationInfo } from '../shared/types';
import type { Env } from './types';
import { A2AError, consumeA2AStream, safeErrorText } from './a2a';
import { credentialFor, type ProjectRow } from './projects';
import { now } from './db';

const TURN_TIMEOUT_MS = 5 * 60_000;
const TEXT_EVENT_INTERVAL_MS = 150;
const MESSAGE_MAX_CHARS = 32_000;
const HISTORY_LIMIT = 200;

/* ───────── conversation storage ───────── */

interface ConversationRow {
  id: string;
  context_id: string | null;
  active_task_id: string | null;
}

async function getOrCreateConversation(env: Env, projectId: string): Promise<ConversationRow> {
  const existing = await env.DB.prepare(
    'SELECT id, context_id, active_task_id FROM conversations WHERE project_id = ?',
  )
    .bind(projectId)
    .first<ConversationRow>();
  if (existing) return existing;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT OR IGNORE INTO conversations (id, project_id, context_id, active_task_id, updated_at) VALUES (?, ?, NULL, NULL, ?)',
  )
    .bind(id, projectId, now())
    .run();
  // Re-read: a concurrent request may have won the insert.
  const row = await env.DB.prepare(
    'SELECT id, context_id, active_task_id FROM conversations WHERE project_id = ?',
  )
    .bind(projectId)
    .first<ConversationRow>();
  return row ?? { id, context_id: null, active_task_id: null };
}

export async function getConversation(
  env: Env,
  projectId: string,
): Promise<{ conversation: ConversationInfo | null; messages: ChatMessage[] }> {
  const row = await env.DB.prepare(
    'SELECT id, context_id, active_task_id FROM conversations WHERE project_id = ?',
  )
    .bind(projectId)
    .first<ConversationRow>();
  if (!row) return { conversation: null, messages: [] };
  // Newest N, presented oldest-first.
  const { results } = await env.DB.prepare(
    `SELECT id, role, content, status, error, created_at AS createdAt FROM messages
     WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`,
  )
    .bind(row.id, HISTORY_LIMIT)
    .all<ChatMessage>();
  return {
    conversation: { contextId: row.context_id, activeTaskId: row.active_task_id },
    messages: (results ?? []).reverse(),
  };
}

/** Clears history and the agent-side conversation ids: the next turn starts cold. */
export async function resetConversation(env: Env, projectId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM messages WHERE conversation_id IN
       (SELECT id FROM conversations WHERE project_id = ?)`,
    ).bind(projectId),
    env.DB.prepare(
      'UPDATE conversations SET context_id = NULL, active_task_id = NULL, updated_at = ? WHERE project_id = ?',
    ).bind(now(), projectId),
  ]);
}

async function insertMessage(
  env: Env,
  conversationId: string,
  fields: { role: 'user' | 'agent'; content: string; status?: string; error?: string | null },
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO messages (conversation_id, role, content, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      conversationId,
      fields.role,
      fields.content,
      fields.status ?? 'complete',
      fields.error ?? null,
      now(),
    )
    .run();
  return Number(result.meta.last_row_id);
}

async function rememberRemoteIds(
  env: Env,
  conversationId: string,
  contextId: string | null,
  activeTaskId: string | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE conversations SET
       context_id = COALESCE(?, context_id),
       active_task_id = ?,
       updated_at = ?
     WHERE id = ?`,
  )
    .bind(contextId, activeTaskId, now(), conversationId)
    .run();
}

/* ───────── the turn ───────── */

export async function handleChatTurn(options: {
  env: Env;
  project: ProjectRow;
  message: string;
  waitUntil: (promise: Promise<unknown>) => void;
  /**
   * Runs after a successful turn, before the `done` event. The bootstrap route uses it to
   * record the readiness report server-side, so the browser is never the thing that
   * decides whether setup finished.
   */
  onComplete?: (result: { text: string; state: string }) => Promise<void>;
}): Promise<Response> {
  const { env, project } = options;
  const projectId = project.id;
  const message = options.message.trim();
  if (!message) throw new A2AError('Message must not be empty.', false);
  if (message.length > MESSAGE_MAX_CHARS) {
    throw new A2AError(`Message is too long (max ${MESSAGE_MAX_CHARS} characters).`, false);
  }

  // Resolve everything that can fail *before* streaming starts, so those failures
  // surface as ordinary JSON errors with proper status codes.
  const cred = await credentialFor(env, project);
  const conversation = await getOrCreateConversation(env, projectId);
  const userMessageId = await insertMessage(env, conversation.id, { role: 'user', content: message });

  const params: Record<string, unknown> = {
    message: {
      kind: 'message',
      role: 'user',
      // Derived from the stored row, not random: messageId is A2A's idempotency key,
      // so a retried send of the same stored message can never bill a second turn.
      messageId: `launch-${conversation.id}-${userMessageId}`,
      ...(conversation.context_id ? { contextId: conversation.context_id } : {}),
      ...(conversation.active_task_id ? { taskId: conversation.active_task_id } : {}),
      parts: [{ kind: 'text', text: message }],
    },
    configuration: { acceptedOutputModes: ['text/plain'] },
  };

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let clientGone = false;

  const send = async (event: ChatEvent) => {
    if (clientGone) return;
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch {
      // The browser went away; keep consuming upstream so the reply still lands in D1.
      clientGone = true;
    }
  };

  const pump = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
    let lastTextSent = 0;
    let idsSaved = false;
    let partial = '';
    try {
      // Flush an initial event right away so intermediaries commit to streaming.
      await send({ type: 'status', state: 'submitted', taskId: null, contextId: null });

      const finalSnapshot = await consumeA2AStream({
        cred,
        params,
        signal: controller.signal,
        onSnapshot: async (snapshot) => {
          partial = snapshot.text;
          // Persist the remote ids as soon as they exist: a crash mid-turn must not
          // orphan the agent-side conversation.
          if (!idsSaved && (snapshot.contextId || snapshot.taskId)) {
            idsSaved = true;
            await rememberRemoteIds(env, conversation.id, snapshot.contextId, snapshot.taskId);
          }
          if (snapshot.state && !snapshot.terminal) {
            await send({
              type: 'status',
              state: snapshot.state,
              taskId: snapshot.taskId,
              contextId: snapshot.contextId,
            });
          }
          const timestamp = Date.now();
          if (snapshot.text && (timestamp - lastTextSent >= TEXT_EVENT_INTERVAL_MS || snapshot.terminal)) {
            lastTextSent = timestamp;
            await send({ type: 'text', text: snapshot.text });
          }
        },
      });

      const state = finalSnapshot.state || 'completed';
      const text =
        finalSnapshot.text.trim() ||
        (state === 'completed' ? '' : `The agent stopped at "${state}" without any text.`);
      if (!text) throw new A2AError(`${cred.label} finished without any text output.`, true);

      // input-required keeps the task id so the next message answers *this* task;
      // every other terminal state closes it.
      const status = state === 'input-required' ? 'input-required' : 'complete';
      await insertMessage(env, conversation.id, { role: 'agent', content: text, status });
      await rememberRemoteIds(
        env,
        conversation.id,
        finalSnapshot.contextId,
        state === 'input-required' ? finalSnapshot.taskId : null,
      );
      if (options.onComplete) await options.onComplete({ text, state });
      await send({ type: 'done', state, text });
    } catch (error) {
      const detail =
        error instanceof Error ? safeErrorText(error.message) : safeErrorText(error);
      // Keep whatever text already streamed; an interrupted answer is still context.
      await insertMessage(env, conversation.id, {
        role: 'agent',
        content: partial,
        status: 'error',
        error: detail,
      });
      await rememberRemoteIds(env, conversation.id, null, null);
      await send({ type: 'error', message: detail });
    } finally {
      clearTimeout(timer);
      try {
        await writer.close();
      } catch {
        /* already closed or client gone */
      }
    }
  };

  options.waitUntil(pump());

  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}
