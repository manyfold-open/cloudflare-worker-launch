/**
 * The development console: chat with the project's agent, with a strip showing whether the
 * deployed app is actually up.
 *
 * History comes from D1 (the source of truth); during a turn the live reply is rendered
 * from `text` events, each of which carries the full accumulated text — the client
 * replaces its buffer, never appends. When the turn ends history is re-fetched, so what
 * you see is what was persisted.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, ProjectStatus, ProjectView } from '../../shared/types';
import { api, del } from '../api';
import { streamTurn } from '../sse';

interface HistoryResponse {
  conversation: { contextId: string | null; activeTaskId: string | null } | null;
  messages: ChatMessage[];
}

export default function Console(props: { project: ProjectView }) {
  const { project } = props;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState<{ status: string; text: string } | null>(null);
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [error, setError] = useState('');
  const scroller = useRef<HTMLDivElement | null>(null);

  const loadHistory = useCallback(async () => {
    const history = await api<HistoryResponse>(`/api/projects/${project.id}/messages`);
    setMessages(history.messages);
  }, [project.id]);

  const loadStatus = useCallback(async () => {
    setStatus(await api<ProjectStatus>(`/api/projects/${project.id}/status`));
  }, [project.id]);

  useEffect(() => {
    void loadHistory().catch(() => undefined);
    void loadStatus().catch(() => undefined);
  }, [loadHistory, loadStatus]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages, live]);

  const send = async () => {
    const text = draft.trim();
    if (!text || live) return;
    setDraft('');
    setError('');
    setMessages((current) => [
      ...current,
      {
        id: -1,
        role: 'user',
        content: text,
        status: 'complete',
        error: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    setLive({ status: 'sending', text: '' });
    try {
      await streamTurn(`/api/projects/${project.id}/chat`, { message: text }, (event) => {
        if (event.type === 'status') setLive((c) => ({ status: event.state, text: c?.text ?? '' }));
        if (event.type === 'text') setLive((c) => ({ status: c?.status ?? 'working', text: event.text }));
        if (event.type === 'error') setError(event.message);
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLive(null);
      await loadHistory().catch(() => undefined);
      // The agent may well have deployed something during that turn.
      await loadStatus().catch(() => undefined);
    }
  };

  const reset = async () => {
    if (live) return;
    if (!window.confirm('Clear this conversation? The agent will also forget its context.')) return;
    await del(`/api/projects/${project.id}/messages`);
    await loadHistory();
  };

  return (
    <section className="panel chat">
      <div className="chat-toolbar">
        <div className="project-id">
          <strong>{project.agentName ?? 'agent'}</strong>
          {project.repoFullName && <span className="muted"> · {project.repoFullName}</span>}
        </div>
        {status && (
          <span className={status.healthy ? 'pill ok' : status.healthy === null ? 'pill' : 'pill bad'}>
            {status.healthy === null
              ? 'no deployment'
              : status.healthy
                ? 'app healthy'
                : `app down — ${status.detail ?? 'unknown'}`}
          </span>
        )}
        {project.workerUrl && (
          <a className="button subtle" href={project.workerUrl} target="_blank" rel="noreferrer">
            Open app ↗
          </a>
        )}
        <button className="button subtle" onClick={() => void reset()} disabled={!messages.length || !!live}>
          Reset
        </button>
      </div>

      {project.bootstrapReport && messages.length === 0 && (
        <pre className="report">{project.bootstrapReport}</pre>
      )}

      <div className="chat-log" ref={scroller}>
        {messages.length === 0 && !live && (
          <p className="muted center">
            Ask for a change — the agent edits the repository, pushes, and Cloudflare deploys it.
          </p>
        )}
        {messages.map((message, index) => (
          <div key={`${message.id}-${index}`} className={`bubble ${message.role}`}>
            <div className="bubble-text">{message.content || (message.error ?? '')}</div>
            {message.status === 'error' && message.error && (
              <div className="bubble-meta error">{message.error}</div>
            )}
            {message.status === 'input-required' && (
              <div className="bubble-meta">The agent is waiting for your answer.</div>
            )}
          </div>
        ))}
        {live && (
          <div className="bubble agent">
            <div className="bubble-text">{live.text || '…'}</div>
            <div className="bubble-meta">{live.status}…</div>
          </div>
        )}
      </div>

      {error && <div className="notice error">{error}</div>}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={live ? 'Waiting for the agent…' : 'Describe a change (Enter to send)'}
          rows={3}
          disabled={!!live}
        />
        <button className="button primary" type="submit" disabled={!draft.trim() || !!live}>
          {live ? 'Working…' : 'Send'}
        </button>
      </form>
    </section>
  );
}
