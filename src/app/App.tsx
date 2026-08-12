/**
 * The shell: loads /api/state once, then shows either the setup wizard or the development
 * console for the current project.
 *
 * There is no client-side router and no local copy of setup progress — `/api/state` is the
 * single source of truth, so a refresh mid-setup lands exactly where it left off.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AppState, ProjectView } from '../shared/types';
import { api, del, post } from './api';
import Wizard from './components/Wizard';
import Console from './components/Console';

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);

  const refreshState = useCallback(async () => {
    try {
      const next = await api<AppState>('/api/state');
      setState(next);
      setLoadError('');
      setActiveId((current) => current ?? next.projects[0]?.id ?? null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  /** Replaces one project in place, so a step transition does not refetch everything. */
  const onProject = useCallback((project: ProjectView) => {
    setState((current) =>
      current
        ? {
            ...current,
            projects: current.projects.map((entry) => (entry.id === project.id ? project : entry)),
          }
        : current,
    );
    setActiveId(project.id);
  }, []);

  if (loadError) {
    return (
      <main className="shell">
        <div className="notice error">
          Could not reach the API: {loadError}{' '}
          <button className="link" onClick={() => void refreshState()}>
            Retry
          </button>
        </div>
      </main>
    );
  }
  if (!state) {
    return (
      <main className="shell">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const active = state.projects.find((project) => project.id === activeId) ?? state.projects[0] ?? null;

  const startProject = async () => {
    const result = await post<{ project: ProjectView }>('/api/projects');
    setState((current) =>
      current ? { ...current, projects: [result.project, ...current.projects] } : current,
    );
    setActiveId(result.project.id);
  };

  const forgetToken = async () => {
    const result = await del<{ note: string }>('/api/account');
    window.alert(result.note);
    await refreshState();
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ✳
          </span>
          <div>
            <h1>Cloudflare Worker Launch</h1>
            <p className="muted">Ship a Cloudflare app, and an agent that keeps building it.</p>
          </div>
        </div>
        <nav className="tabs" aria-label="Projects">
          {state.projects.map((project) => (
            <button
              key={project.id}
              className={project.id === active?.id ? 'tab active' : 'tab'}
              onClick={() => setActiveId(project.id)}
            >
              {/* Unnamed projects are indistinguishable otherwise: an agent has no name
                  until step 3, and a user can have several in flight. */}
              {project.agentName ?? project.repoFullName ?? `New · ${project.id.slice(4, 10)}`}
            </button>
          ))}
          <button className="tab" onClick={() => void startProject()}>
            + New
          </button>
        </nav>
      </header>

      {!active && (
        <section className="panel">
          <h2>Start a project</h2>
          <p className="muted">
            Deploy the starter app to your own Cloudflare account, then hand it to an agent
            that can develop it for you.
          </p>
          <button className="button primary" onClick={() => void startProject()}>
            Get started
          </button>
        </section>
      )}

      {active && active.setupState !== 'done' && (
        <Wizard
          project={active}
          connected={state.connected}
          hasManagementToken={state.hasManagementToken}
          scopes={state.requiredScopes}
          apiHost={state.apiHost}
          tokenPageUrl={state.tokenPageUrl}
          deployButtonUrl={state.deployButtonUrl}
          refresh={refreshState}
          onProject={onProject}
        />
      )}

      {active && active.setupState === 'done' && <Console project={active} />}

      {state.connected && state.hasManagementToken && active?.setupState === 'done' && (
        <p className="hint footer-note">
          This app still holds your Manyfold account token.{' '}
          <button className="link" onClick={() => void forgetToken()}>
            Forget it
          </button>{' '}
          — chatting with the agent keeps working without it.
        </p>
      )}
    </main>
  );
}
