/**
 * D1 access: the schema and the settings key/value store.
 *
 * The schema lives here as a string and is applied on the first request of each isolate
 * rather than through migrations, because the "Deploy to Cloudflare" button provisions the
 * database but never runs a migration command — and because `npm run dev` should work with
 * no setup at all. Every statement must stay idempotent: they run on every cold start as a
 * single batch, so one failing statement fails the batch and every request 500s.
 *
 * This module deliberately imports nothing from crypto.ts: crypto.ts reads its key
 * material from `settings` through here, and one direction keeps that simple.
 */

import type { Env } from './types';

export const now = (): string => new Date().toISOString();

/** Opaque, unguessable row ids. Used for sessions (which are also credentials) and projects. */
export function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return `${prefix}_${out}`;
}

/* ───────── schema ───────── */

/**
 * Database schema. Add your own tables here — they are created on the next request.
 * Keep semicolons out of statement bodies: the splitter below treats every semicolon
 * as a statement boundary.
 */
const SCHEMA = `
-- Generic key/value store. The app keeps its generated encryption key here;
-- the rest of the namespace is yours.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per Manyfold account that has used this launcher. The management token is the
-- user's own account credential: sealed at rest, and dropped as soon as setup no longer
-- needs it. We never learn its token id (a pasted token cannot be located in
-- /me/api-tokens), so dropping it is all this app can do — revocation is the user's, on
-- Manyfold.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  token_ct   TEXT,
  token_iv   TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Anonymous browser session, upgraded to a tenant session once a token is verified.
-- user_id stays NULL until then.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- One launch project: a deployed app plus the agent that develops it. Every query
-- touching this table must be scoped by user_id.
CREATE TABLE IF NOT EXISTS projects (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  template              TEXT NOT NULL DEFAULT 'cloudflare-worker-starter',
  worker_url            TEXT,
  repo_full_name        TEXT,
  connection_id         TEXT,
  agent_id              TEXT,
  agent_name            TEXT,
  rpc_url               TEXT,
  chat_token_ct         TEXT,
  chat_token_iv         TEXT,
  chat_token_id         TEXT,
  chat_token_expires_at TEXT,
  setup_state           TEXT NOT NULL DEFAULT 'deploy',
  bootstrap_task_id     TEXT,
  bootstrap_report      TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects (user_id, created_at);

-- One conversation per project. context_id / active_task_id give the agent multi-turn
-- memory across requests; both are cleared when the conversation is reset.
CREATE TABLE IF NOT EXISTS conversations (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL UNIQUE,
  context_id     TEXT,
  active_task_id TEXT,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'complete',
  error           TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, id);
`;

/**
 * Split SQL into statements: drop `--` comments first, then split on ';'.
 * Comments go first because they are allowed to contain punctuation that would
 * otherwise split a statement in half. Statement bodies are not.
 */
export function schemaStatements(sql: string): string[] {
  return sql
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

let initialized: Promise<void> | null = null;

/** Idempotent; runs at most once per isolate, and retries on the next request if it fails. */
export function ensureSchema(db: D1Database): Promise<void> {
  if (!initialized) {
    initialized = db
      .batch(schemaStatements(SCHEMA).map((statement) => db.prepare(statement)))
      .then(() => undefined)
      .catch((error) => {
        initialized = null;
        throw error;
      });
  }
  return initialized;
}

/* ───────── settings ───────── */

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, now())
    .run();
}

/** Writes only if the key is unset. Used for the generated encryption key, where
 *  concurrent first requests must converge on a single winner. */
export async function setSettingIfAbsent(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
    .bind(key, value, now())
    .run();
}
