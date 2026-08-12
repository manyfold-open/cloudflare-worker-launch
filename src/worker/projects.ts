/**
 * Project storage.
 *
 * A project is one deployed app plus the agent that develops it. Two rules hold everywhere
 * in this file, and are worth stating once rather than repeating in every function:
 *
 *   1. **Every query is scoped by user_id.** An agent belongs to the account that
 *      authorized it, and a leak across tenants would bill one customer's turns to
 *      another's agent. `loadProject` is the only read path, so it is the only place that
 *      has to get this right.
 *   2. **The conversation token never leaves the Worker.** It is sealed with the rest of
 *      the credentials and reaches the browser in no form, not even masked.
 */

import type { AgentCredential, Env } from './types';
import { HttpError } from './types';
import { now, randomId } from './db';
import { seal, unseal } from './crypto';
import { validateA2AUrl } from './a2a';
import type { ProjectView, SetupState } from '../shared/types';

export interface ProjectRow {
  id: string;
  user_id: string;
  template: string;
  worker_url: string | null;
  repo_full_name: string | null;
  connection_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  rpc_url: string | null;
  chat_token_ct: string | null;
  chat_token_iv: string | null;
  chat_token_id: string | null;
  chat_token_expires_at: string | null;
  setup_state: string;
  bootstrap_task_id: string | null;
  bootstrap_report: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, user_id, template, worker_url, repo_full_name, connection_id, agent_id,
  agent_name, rpc_url, chat_token_ct, chat_token_iv, chat_token_id, chat_token_expires_at,
  setup_state, bootstrap_task_id, bootstrap_report, created_at, updated_at`;

export async function createProject(env: Env, userId: string): Promise<ProjectRow> {
  const id = randomId('prj');
  const stamp = now();
  await env.DB.prepare(
    `INSERT INTO projects (id, user_id, setup_state, created_at, updated_at)
     VALUES (?, ?, 'deploy', ?, ?)`,
  )
    .bind(id, userId, stamp, stamp)
    .run();
  const row = await loadProject(env, userId, id);
  if (!row) throw new HttpError(500, 'internal', 'Project vanished right after creation.');
  return row;
}

/** The only read path, and therefore the only place tenant scoping has to be enforced. */
export async function loadProject(
  env: Env,
  userId: string,
  projectId: string,
): Promise<ProjectRow | null> {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM projects WHERE id = ? AND user_id = ?`)
    .bind(projectId, userId)
    .first<ProjectRow>();
  return row ?? null;
}

export async function requireProject(
  env: Env,
  userId: string,
  projectId: string,
): Promise<ProjectRow> {
  const row = await loadProject(env, userId, projectId);
  if (!row) throw new HttpError(404, 'not_found', 'No such project.');
  return row;
}

export async function listProjects(env: Env, userId: string): Promise<ProjectRow[]> {
  const result = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM projects WHERE user_id = ? ORDER BY created_at DESC`,
  )
    .bind(userId)
    .all<ProjectRow>();
  return result.results ?? [];
}

type Patch = Partial<{
  worker_url: string | null;
  repo_full_name: string | null;
  connection_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  rpc_url: string | null;
  chat_token_ct: string | null;
  chat_token_iv: string | null;
  chat_token_id: string | null;
  chat_token_expires_at: string | null;
  setup_state: SetupState;
  bootstrap_task_id: string | null;
  bootstrap_report: string | null;
}>;

export async function updateProject(
  env: Env,
  userId: string,
  projectId: string,
  patch: Patch,
): Promise<ProjectRow> {
  const keys = Object.keys(patch) as (keyof Patch)[];
  if (keys.length > 0) {
    const assignments = keys.map((key) => `${key} = ?`).join(', ');
    await env.DB.prepare(
      `UPDATE projects SET ${assignments}, updated_at = ? WHERE id = ? AND user_id = ?`,
    )
      .bind(...keys.map((key) => patch[key] ?? null), now(), projectId, userId)
      .run();
  }
  return requireProject(env, userId, projectId);
}

/** Records how this project got its agent, so cleanup knows what it is allowed to delete. */
export async function rememberAgentOrigin(
  env: Env,
  projectId: string,
  agentId: string,
  createdByUs: boolean,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO project_agents (project_id, agent_id, created_by_us, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (project_id) DO UPDATE SET
       agent_id = excluded.agent_id,
       created_by_us = excluded.created_by_us`,
  )
    .bind(projectId, agentId, createdByUs ? 1 : 0, now())
    .run();
}

/** True only for an agent this app created — never for one the user already owned. */
export async function agentWasCreatedByUs(env: Env, projectId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT created_by_us FROM project_agents WHERE project_id = ?',
  )
    .bind(projectId)
    .first<{ created_by_us: number }>();
  return row?.created_by_us === 1;
}

export async function deleteProject(env: Env, userId: string, projectId: string): Promise<void> {
  const conversation = await env.DB.prepare('SELECT id FROM conversations WHERE project_id = ?')
    .bind(projectId)
    .first<{ id: string }>();
  if (conversation) {
    await env.DB.prepare('DELETE FROM messages WHERE conversation_id = ?').bind(conversation.id).run();
    await env.DB.prepare('DELETE FROM conversations WHERE id = ?').bind(conversation.id).run();
  }
  await env.DB.prepare('DELETE FROM project_agents WHERE project_id = ?').bind(projectId).run();
  await env.DB.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?')
    .bind(projectId, userId)
    .run();
}

/* ───────── conversation credential ───────── */

export async function storeChatCredential(
  env: Env,
  userId: string,
  projectId: string,
  input: { rpcUrl: string; token: string; tokenId: string; expiresAt: string | null; agentName: string },
): Promise<ProjectRow> {
  const production = (env.ENVIRONMENT ?? '').toLowerCase() === 'production';
  // The rpcUrl comes from the platform, but it is still input: validating before storage
  // keeps a spoofed or mistaken response from turning this Worker into an SSRF proxy.
  const rpcUrl = validateA2AUrl(input.rpcUrl, production, 'agent rpcUrl');
  const sealed = await seal(env, input.token);
  return updateProject(env, userId, projectId, {
    rpc_url: rpcUrl,
    agent_name: input.agentName,
    chat_token_ct: sealed.ciphertext,
    chat_token_iv: sealed.iv,
    chat_token_id: input.tokenId,
    chat_token_expires_at: input.expiresAt,
  });
}

/** Decrypts a project's conversation credential. The extension point for new call sites. */
export async function credentialFor(env: Env, project: ProjectRow): Promise<AgentCredential> {
  if (!project.rpc_url || !project.chat_token_ct || !project.chat_token_iv) {
    throw new HttpError(400, 'agent_not_ready', 'This project has no connected agent yet.');
  }
  if (project.chat_token_expires_at && project.chat_token_expires_at <= now()) {
    throw new HttpError(
      401,
      'credential_expired',
      'The agent credential for this project has expired. Reconnect your Manyfold account to mint a new one.',
    );
  }
  return {
    rpcUrl: project.rpc_url,
    token: await unseal(env, project.chat_token_ct, project.chat_token_iv),
    label: project.agent_name ?? 'agent',
  };
}

/* ───────── serialization ───────── */

const SETUP_ORDER: SetupState[] = ['deploy', 'auth', 'agent', 'github', 'bootstrap', 'done'];

export function asSetupState(value: string): SetupState {
  return (SETUP_ORDER as string[]).includes(value) ? (value as SetupState) : 'deploy';
}

/** The browser-facing shape. Deliberately omits every *_ct / *_iv column. */
export function toView(row: ProjectRow): ProjectView {
  return {
    id: row.id,
    template: row.template,
    workerUrl: row.worker_url,
    repoFullName: row.repo_full_name,
    connectionId: row.connection_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    hasCredential: Boolean(row.chat_token_ct),
    credentialExpiresAt: row.chat_token_expires_at,
    setupState: asSetupState(row.setup_state),
    bootstrapReport: row.bootstrap_report,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
