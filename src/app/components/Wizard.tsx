/**
 * The setup wizard: five steps, each one gated on the previous having actually succeeded
 * rather than merely having been visited.
 *
 * Progress lives in `project.setupState` on the server, not in component state, so a
 * closed tab, a refresh, or a second device all resume in the same place. Every step here
 * is a thin shell around one server call — the orchestration lives in the Worker, because
 * that is where the credentials are and where a half-finished setup has to be cleaned up.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  AgentOptionView,
  ConnectionView,
  ProjectView,
  ProviderOptionView,
  RepoView,
  SetupState,
} from '../../shared/types';
import { ApiError, api, post } from '../api';
import { streamTurn } from '../sse';

const STEPS: { key: SetupState; label: string }[] = [
  { key: 'deploy', label: 'Deploy' },
  { key: 'auth', label: 'Authorize' },
  { key: 'agent', label: 'Agent' },
  { key: 'github', label: 'GitHub' },
  { key: 'bootstrap', label: 'Readiness' },
];

const stepIndex = (state: SetupState): number => {
  const found = STEPS.findIndex((step) => step.key === state);
  return found === -1 ? STEPS.length : found;
};

function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

/* ───────── step 1: deploy ───────── */

function DeployStep(props: {
  deployButtonUrl: string;
  project: ProjectView;
  onDone: (project: ProjectView) => void;
}) {
  const [url, setUrl] = useState(props.project.workerUrl ?? '');
  const { busy, error, run } = useAsyncAction();

  return (
    <section className="panel">
      <h2>1 · Deploy the app</h2>
      <p className="muted">
        This creates a copy of the starter template in your own GitHub account, provisions a
        D1 database, and wires up automatic deploys. You keep everything.
      </p>

      <div className="notice warn">
        <strong>Expand “Advanced settings” once before you click Deploy.</strong> While that
        section is collapsed, Cloudflare’s form fails after creating the repository but
        before the first build, leaving a half-built app. Opening it once is enough.
      </div>

      <p>
        <a className="button primary" href={props.deployButtonUrl} target="_blank" rel="noreferrer">
          Deploy to Cloudflare ↗
        </a>
      </p>

      <label className="field">
        <span>Paste your app’s URL once the deploy finishes</span>
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://your-app.workers.dev"
          spellCheck={false}
        />
      </label>

      {error && <div className="notice error">{error}</div>}

      <button
        className="button primary"
        disabled={busy || !url.trim()}
        onClick={() =>
          void run(async () => {
            const result = await post<{ project: ProjectView }>(
              `/api/projects/${props.project.id}/worker`,
              { workerUrl: url.trim() },
            );
            props.onDone(result.project);
          })
        }
      >
        {busy ? 'Checking…' : 'Check and continue'}
      </button>
      <p className="hint">We call <code>/api/health</code> on that URL to confirm it is live.</p>
    </section>
  );
}

/* ───────── step 2: authorize ───────── */

function AuthStep(props: {
  scopes: string[];
  apiHost: string;
  tokenPageUrl: string;
  onDone: () => Promise<void>;
}) {
  const [token, setToken] = useState('');
  const { busy, error, run } = useAsyncAction();

  return (
    <section className="panel">
      <h2>2 · Authorize your Manyfold account</h2>
      <p className="muted">
        Create an API token with exactly these scopes and paste it below. We use it only to
        set the agent up, and you can have us forget it the moment setup is done.
      </p>

      {/* Named up front because tokens are per-environment: pasting a token from a
          different Manyfold environment fails with a flat "api token not found", which
          reads like a bad paste rather than the wrong host. */}
      <p className="hint">
        This app talks to <code>{props.apiHost}</code>
        {props.tokenPageUrl && (
          <>
            {' — create the token at '}
            <a href={props.tokenPageUrl} target="_blank" rel="noreferrer">
              {props.tokenPageUrl.replace(/^https:\/\//, '')} ↗
            </a>
          </>
        )}
        . A token from any other Manyfold environment will be rejected.
      </p>

      <ul className="scopes">
        {props.scopes.map((scope) => (
          <li key={scope}>
            <code>{scope}</code>
          </li>
        ))}
      </ul>
      <p className="hint">
        We never ask for <code>secrets</code>, <code>terminal</code>, <code>files</code> or{' '}
        <code>chat</code> scopes.
      </p>

      <label className="field">
        <span>Account token</span>
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="nca_…"
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      {error && <div className="notice error">{error}</div>}

      <button
        className="button primary"
        disabled={busy || !token.trim()}
        onClick={() =>
          void run(async () => {
            await post('/api/account', { token: token.trim() });
            setToken('');
            await props.onDone();
          })
        }
      >
        {busy ? 'Verifying…' : 'Connect account'}
      </button>
    </section>
  );
}

/* ───────── step 3: agent ───────── */

function AgentStep(props: { project: ProjectView; onDone: (project: ProjectView) => void }) {
  const [options, setOptions] = useState<{
    agents: AgentOptionView[];
    providers: ProviderOptionView[];
  } | null>(null);
  const [mode, setMode] = useState<'create' | 'adopt'>('create');
  const [name, setName] = useState('my-app-agent');
  const [providerId, setProviderId] = useState('');
  const [adoptId, setAdoptId] = useState('');
  const { busy, error, setError, run } = useAsyncAction();

  useEffect(() => {
    api<{ agents: AgentOptionView[]; providers: ProviderOptionView[] }>(
      `/api/projects/${props.project.id}/agent-options`,
    )
      .then((result) => {
        setOptions(result);
        setProviderId(result.providers[0]?.providerId ?? '');
        setAdoptId(result.agents.find((agent) => agent.eligible)?.agentId ?? '');
        if (result.providers.length === 0) setMode('adopt');
      })
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : String(cause)));
  }, [props.project.id, setError]);

  const provider = options?.providers.find((entry) => entry.providerId === providerId) ?? null;

  return (
    <section className="panel">
      <h2>3 · Prepare the agent</h2>
      <p className="muted">
        We create the agent, point it at one of your account’s models, install the
        development skill for this template, and mint a credential this app can use to talk
        to it. No agent turns run here, so nothing is billed yet.
      </p>

      <div className="tabs">
        <button
          className={mode === 'create' ? 'tab active' : 'tab'}
          onClick={() => setMode('create')}
          disabled={!options || options.providers.length === 0}
        >
          Create a new agent
        </button>
        <button
          className={mode === 'adopt' ? 'tab active' : 'tab'}
          onClick={() => setMode('adopt')}
          disabled={!options || options.agents.length === 0}
        >
          Use an existing one
        </button>
      </div>

      {!options && <p className="muted">Loading your account…</p>}

      {options && mode === 'create' && (
        <>
          <label className="field">
            <span>Agent name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="field">
            <span>Model provider</span>
            <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
              {options.providers.map((entry) => (
                <option key={entry.providerId} value={entry.providerId}>
                  {entry.name} · {entry.framework}
                </option>
              ))}
            </select>
          </label>
          {provider?.preferredModel && (
            <p className="hint">
              Model: <code>{provider.preferredModel}</code>
              {provider.models.length > 1 && ` · ${provider.models.length} available on this provider`}
            </p>
          )}
        </>
      )}

      {options && mode === 'adopt' && (
        <label className="field">
          <span>Agent</span>
          <select value={adoptId} onChange={(event) => setAdoptId(event.target.value)}>
            {options.agents.map((agent) => (
              <option key={agent.agentId} value={agent.agentId} disabled={!agent.eligible}>
                {agent.name} · {agent.framework}
                {agent.eligible ? '' : ' (runtime cannot hold GitHub credentials)'}
              </option>
            ))}
          </select>
        </label>
      )}

      {error && <div className="notice error">{error}</div>}

      <button
        className="button primary"
        disabled={busy || !options || (mode === 'create' ? !providerId : !adoptId)}
        onClick={() =>
          void run(async () => {
            const body =
              mode === 'create'
                ? { mode, name: name.trim(), framework: provider?.framework, providerId }
                : { mode, agentId: adoptId };
            const result = await post<{ project: ProjectView }>(
              `/api/projects/${props.project.id}/agent`,
              body,
            );
            props.onDone(result.project);
          })
        }
      >
        {busy ? 'Provisioning… (this can take a minute)' : 'Set up the agent'}
      </button>
    </section>
  );
}

/* ───────── step 4: github ───────── */

function GithubStep(props: { project: ProjectView; onDone: (project: ProjectView) => void }) {
  const [connections, setConnections] = useState<ConnectionView[] | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [repos, setRepos] = useState<RepoView[] | null>(null);
  const [repo, setRepo] = useState('');
  const { busy, error, setError, run } = useAsyncAction();

  const loadConnections = useCallback(async () => {
    const result = await api<{ connections: ConnectionView[] }>(
      `/api/projects/${props.project.id}/connections`,
    );
    setConnections(result.connections);
    setConnectionId((current) => current || result.connections[0]?.id || '');
  }, [props.project.id]);

  useEffect(() => {
    loadConnections().catch((cause) =>
      setError(cause instanceof ApiError ? cause.message : String(cause)),
    );
  }, [loadConnections, setError]);

  useEffect(() => {
    if (!connectionId) return;
    setRepos(null);
    api<{ repos: RepoView[] }>(
      `/api/projects/${props.project.id}/repos?connectionId=${encodeURIComponent(connectionId)}`,
    )
      .then((result) => {
        setRepos(result.repos);
        setRepo((current) => current || result.repos[0]?.fullName || '');
      })
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : String(cause)));
  }, [connectionId, props.project.id, setError]);

  return (
    <section className="panel">
      <h2>4 · Give the agent your repository</h2>
      <p className="muted">
        This is a <em>different</em> authorization from the one Cloudflare asked for in step 1.
        That one lets Cloudflare deploy; this one lets your agent clone and push.
      </p>

      {connections?.length === 0 && (
        <>
          <p>No GitHub connection on your account yet.</p>
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await post<{ url: string }>(
                  `/api/projects/${props.project.id}/github/start`,
                );
                window.open(result.url, '_blank', 'noopener,noreferrer');
              })
            }
          >
            Install the GitHub App ↗
          </button>
          <p className="hint">
            Make sure the app can see the repository the Deploy button created. Come back and{' '}
            <button className="link" onClick={() => void loadConnections()}>
              refresh
            </button>
            .
          </p>
        </>
      )}

      {connections && connections.length > 0 && (
        <>
          <label className="field">
            <span>GitHub connection</span>
            <select value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.displayName}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Repository</span>
            <select
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              disabled={!repos}
            >
              {(repos ?? []).map((entry) => (
                <option key={entry.fullName} value={entry.fullName}>
                  {entry.fullName}
                  {entry.private ? ' (private)' : ''}
                </option>
              ))}
            </select>
          </label>
          {repos?.length === 0 && (
            <p className="hint">
              This connection cannot see any repositories. Widen the GitHub App’s access, then
              reselect it.
            </p>
          )}
        </>
      )}

      {error && <div className="notice error">{error}</div>}

      <button
        className="button primary"
        disabled={busy || !connectionId || !repo}
        onClick={() =>
          void run(async () => {
            const result = await post<{ project: ProjectView }>(
              `/api/projects/${props.project.id}/repo`,
              { connectionId, repoFullName: repo },
            );
            props.onDone(result.project);
          })
        }
      >
        {busy ? 'Linking…' : 'Link repository'}
      </button>
    </section>
  );
}

/* ───────── step 5: bootstrap ───────── */

function BootstrapStep(props: { project: ProjectView; onDone: () => Promise<void> }) {
  const [live, setLive] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const { busy, error, setError, run } = useAsyncAction();

  return (
    <section className="panel">
      <h2>5 · Readiness check</h2>
      <p className="muted">
        The agent clones the repository, reads the project’s conventions, checks it can push,
        and runs the test suite — then reports back.
      </p>
      <div className="notice">
        This runs one real agent turn, which is billed to your Manyfold account. Everything
        before this point was free.
      </div>

      {live !== null && (
        <pre className="report">{live || `${status || 'working'}…`}</pre>
      )}
      {error && <div className="notice error">{error}</div>}

      <button
        className="button primary"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            setLive('');
            await streamTurn(`/api/projects/${props.project.id}/bootstrap`, {}, (event) => {
              if (event.type === 'status') setStatus(event.state);
              if (event.type === 'text') setLive(event.text);
              if (event.type === 'done') setLive(event.text);
              if (event.type === 'error') setError(event.message);
            });
            await props.onDone();
          })
        }
      >
        {busy ? 'Running…' : 'Run the check'}
      </button>
    </section>
  );
}

/* ───────── shell ───────── */

export default function Wizard(props: {
  project: ProjectView;
  connected: boolean;
  scopes: string[];
  apiHost: string;
  tokenPageUrl: string;
  deployButtonUrl: string;
  refresh: () => Promise<void>;
  onProject: (project: ProjectView) => void;
}) {
  // The server owns progress, with one exception: a project can be past step 1 while the
  // session has no account bound (a token was discarded, or this is a new browser), and
  // in that case authorization is what we actually need next.
  const effective: SetupState =
    !props.connected && props.project.setupState !== 'deploy' ? 'auth' : props.project.setupState;
  const current = stepIndex(effective);

  return (
    <div className="wizard">
      <ol className="steps">
        {STEPS.map((step, index) => (
          <li
            key={step.key}
            className={index < current ? 'done' : index === current ? 'active' : ''}
          >
            <span className="dot">{index < current ? '✓' : index + 1}</span>
            {step.label}
          </li>
        ))}
      </ol>

      {effective === 'deploy' && (
        <DeployStep
          deployButtonUrl={props.deployButtonUrl}
          project={props.project}
          onDone={props.onProject}
        />
      )}
      {effective === 'auth' && (
        <AuthStep
          scopes={props.scopes}
          apiHost={props.apiHost}
          tokenPageUrl={props.tokenPageUrl}
          onDone={props.refresh}
        />
      )}
      {effective === 'agent' && <AgentStep project={props.project} onDone={props.onProject} />}
      {effective === 'github' && <GithubStep project={props.project} onDone={props.onProject} />}
      {effective === 'bootstrap' && (
        <BootstrapStep project={props.project} onDone={props.refresh} />
      )}
    </div>
  );
}
