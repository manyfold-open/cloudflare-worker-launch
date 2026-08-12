/**
 * Deleting a launch.
 *
 * The dialog asks the server what this particular delete would remove before saying
 * anything, because the honest answer differs per project: an agent this app created can
 * be deleted with it, one that was adopted cannot, and a project that never got that far
 * has nothing but a local row. A generic "are you sure?" would either overpromise or
 * frighten people away from cleaning up.
 *
 * Afterwards it reports what actually happened, including anything that had to be left
 * behind — a credential we could not revoke is the user's problem to finish, and hiding
 * that would be worse than the inconvenience of saying it.
 */

import { useEffect, useState } from 'react';
import type { ProjectView } from '../../shared/types';
import { ApiError, api, del } from '../api';

interface DeletionPreview {
  agentName: string | null;
  agentCreatedByUs: boolean;
  hasCredential: boolean;
  repoFullName: string | null;
}

interface TeardownReport {
  did: string[];
  leftBehind: string[];
}

export default function DeleteProject(props: {
  project: ProjectView;
  onDeleted: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [alsoAgent, setAlsoAgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<TeardownReport | null>(null);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setError('');
    api<DeletionPreview>(`/api/projects/${props.project.id}/deletion`)
      .then(setPreview)
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : String(cause)));
  }, [open, props.project.id]);

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await del<TeardownReport>(
        `/api/projects/${props.project.id}${alsoAgent ? '?deleteAgent=true' : ''}`,
      );
      // Deliberately not refreshing here: the parent renders this component inside the
      // active project's block, so reloading state now unmounts the dialog and the report
      // with it. The refresh happens when the user dismisses it.
      setReport(result);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    const deleted = report !== null;
    setOpen(false);
    setReport(null);
    setAlsoAgent(false);
    setError('');
    if (deleted) await props.onDeleted();
  };

  if (!open) {
    return (
      <button className="button subtle" onClick={() => setOpen(true)}>
        Delete
      </button>
    );
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="dialog">
        {report ? (
          <>
            <h3>Deleted</h3>
            <ul className="report-list">
              {report.did.map((line) => (
                <li key={line}>✓ {line}</li>
              ))}
            </ul>
            {report.leftBehind.length > 0 && (
              <>
                <p className="muted">Left for you:</p>
                <ul className="report-list muted">
                  {report.leftBehind.map((line) => (
                    <li key={line}>· {line}</li>
                  ))}
                </ul>
              </>
            )}
            <div className="row">
              <button className="button primary" onClick={() => void close()}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <h3>Delete this launch?</h3>
            {!preview && !error && <p className="muted">Checking what this would remove…</p>}

            {preview && (
              <>
                <ul className="report-list">
                  <li>The project and its chat history are removed from this app.</li>
                  {preview.hasCredential && (
                    <li>
                      The agent credential this app minted is revoked
                      {preview.agentName ? ` on ${preview.agentName}` : ''}.
                    </li>
                  )}
                  {preview.repoFullName && (
                    <li className="muted">
                      {preview.repoFullName} and its Cloudflare deployment stay exactly as they are.
                    </li>
                  )}
                </ul>

                {preview.agentCreatedByUs && preview.agentName && (
                  <label className="checkline">
                    <input
                      type="checkbox"
                      checked={alsoAgent}
                      onChange={(event) => setAlsoAgent(event.target.checked)}
                    />
                    <span>
                      Also delete the agent <strong>{preview.agentName}</strong> on Manyfold. This
                      app created it, and deleting it takes its skills and workspace with it.
                    </span>
                  </label>
                )}
                {preview.agentName && !preview.agentCreatedByUs && (
                  <p className="hint">
                    {preview.agentName} was already on your account before this project, so it is
                    left alone.
                  </p>
                )}
              </>
            )}

            {error && <div className="notice error">{error}</div>}

            <div className="row">
              <button className="button danger" disabled={busy || !preview} onClick={() => void confirm()}>
                {busy ? 'Deleting…' : alsoAgent ? 'Delete launch and agent' : 'Delete launch'}
              </button>
              <button className="button subtle" disabled={busy} onClick={() => void close()}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
