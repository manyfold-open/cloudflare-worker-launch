/**
 * Tests for the launcher-specific pieces. Two of these guard security invariants rather
 * than behaviour — `toView` must never leak a credential, and the tenant guard must refuse
 * an unbound session — so treat a failure here as a bug in the product, not the test.
 */

import { describe, expect, it } from 'vitest';
import { asSetupState, toView, type ProjectRow } from '../src/worker/projects';
import { bootstrapPrompt, chooseModel } from '../src/worker/setup';
import {
  FRAMEWORK_PROTOCOL,
  manyfoldEnvironment,
  pickProvider,
  providerModels,
  type ModelProvider,
} from '../src/worker/manyfold';
import {
  readSessionCookie,
  requireBoundTenant,
  requireTenant,
  sessionCookie,
} from '../src/worker/session';
import { HttpError } from '../src/worker/types';

const row = (overrides: Partial<ProjectRow> = {}): ProjectRow => ({
  id: 'prj_1',
  user_id: 'user_1',
  template: 'cloudflare-worker-starter',
  worker_url: 'https://app.example.workers.dev',
  repo_full_name: 'octocat/my-app',
  connection_id: 'ucn_1',
  agent_id: 'agt_1',
  agent_name: 'my-agent',
  rpc_url: 'https://api.manyfold.ai/api/a2a/agents/agt_1/rpc',
  chat_token_ct: 'CIPHERTEXT-SHOULD-NEVER-ESCAPE',
  chat_token_iv: 'IV-SHOULD-NEVER-ESCAPE',
  chat_token_id: 'pat_1',
  chat_token_expires_at: null,
  setup_state: 'done',
  bootstrap_task_id: null,
  bootstrap_report: '1. Clone OK',
  created_at: '2026-08-12T00:00:00.000Z',
  updated_at: '2026-08-12T00:00:00.000Z',
  ...overrides,
});

describe('toView', () => {
  it('never serializes credential material', () => {
    const serialized = JSON.stringify(toView(row()));
    expect(serialized).not.toContain('CIPHERTEXT-SHOULD-NEVER-ESCAPE');
    expect(serialized).not.toContain('IV-SHOULD-NEVER-ESCAPE');
    expect(serialized).not.toContain('pat_1');
    // The browser still needs to know a credential exists, just not what it is.
    expect(toView(row()).hasCredential).toBe(true);
  });

  it('reports a missing credential rather than inventing one', () => {
    expect(toView(row({ chat_token_ct: null, chat_token_iv: null })).hasCredential).toBe(false);
  });

  it('falls back to the first step for an unknown setup state', () => {
    expect(asSetupState('nonsense')).toBe('deploy');
    expect(asSetupState('github')).toBe('github');
  });
});

describe('tenant resolution', () => {
  it('refuses a request with no session at all', () => {
    expect(() => requireTenant(null)).toThrow(HttpError);
    expect(() => requireBoundTenant(null)).toThrow(HttpError);
  });

  it('treats an anonymous session as its own tenant, so step 1 works before authorizing', () => {
    expect(requireTenant({ id: 'ses_1', user_id: null, expires_at: '' })).toEqual({
      sessionId: 'ses_1',
      userId: 'ses_1',
      bound: false,
    });
  });

  it('prefers the account id once the session is bound', () => {
    expect(requireTenant({ id: 'ses_1', user_id: 'user_1', expires_at: '' })).toEqual({
      sessionId: 'ses_1',
      userId: 'user_1',
      bound: true,
    });
  });

  it('still refuses an anonymous session where the account itself is needed', () => {
    expect(() => requireBoundTenant({ id: 'ses_1', user_id: null, expires_at: '' })).toThrow(
      HttpError,
    );
    expect(requireBoundTenant({ id: 'ses_1', user_id: 'user_1', expires_at: '' }).bound).toBe(true);
  });
});

describe('session cookie', () => {
  it('is HttpOnly and SameSite, and Secure only over https', () => {
    const secure = sessionCookie('ses_1', true);
    expect(secure).toContain('HttpOnly');
    expect(secure).toContain('SameSite=Lax');
    expect(secure).toContain('Secure');
    // Local dev is plain http; a Secure cookie there would never be sent back.
    expect(sessionCookie('ses_1', false)).not.toContain('Secure');
  });

  it('reads its own cookie back out of a crowded header', () => {
    expect(readSessionCookie('other=1; cwl_session=ses_9; another=2')).toBe('ses_9');
    expect(readSessionCookie('other=1')).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
  });
});

describe('pickProvider', () => {
  const provider = (overrides: Partial<ModelProvider>): ModelProvider => ({
    id: 'ump_1',
    providerName: 'Managed OpenAI',
    inferenceProtocol: FRAMEWORK_PROTOCOL.codex,
    source: 'managed',
    lastTestStatus: 'ok',
    lastTestModels: { openai_responses: ['gpt-5.6-luna'] },
    ...overrides,
  });

  it('ignores providers whose protocol the framework cannot drive', () => {
    const anthropic = provider({ id: 'ump_2', inferenceProtocol: 'anthropic_messages' });
    expect(pickProvider([anthropic], 'codex')).toBeNull();
    expect(pickProvider([anthropic], 'claude-code')?.id).toBe('ump_2');
  });

  it('ignores providers that failed their last test', () => {
    expect(pickProvider([provider({ lastTestStatus: 'failed' })], 'codex')).toBeNull();
  });

  it('prefers a managed provider so the user needs no key of their own', () => {
    const byo = provider({ id: 'ump_byo', source: 'byo' });
    const managed = provider({ id: 'ump_managed', source: 'managed' });
    expect(pickProvider([byo, managed], 'codex')?.id).toBe('ump_managed');
  });

  it('flattens the advertised models across protocols', () => {
    expect(providerModels(provider({ lastTestModels: { a: ['x'], b: ['y', 'z'] } }))).toEqual([
      'x',
      'y',
      'z',
    ]);
  });
});

describe('bootstrapPrompt', () => {
  it('names the repo and the deployment, and forbids changes', () => {
    const prompt = bootstrapPrompt(row());
    expect(prompt).toContain('octocat/my-app');
    expect(prompt).toContain('https://app.example.workers.dev');
    expect(prompt).toContain('--dry-run');
    expect(prompt).toMatch(/do not push/i);
  });

  it('degrades honestly when the deployment URL is unknown', () => {
    expect(bootstrapPrompt(row({ worker_url: null }))).toContain('has not shared the URL');
  });
});

describe('chooseModel', () => {
  it('takes the preferred model when the provider offers it', () => {
    expect(chooseModel('codex', ['gpt-5.5', 'gpt-5.6-luna'])).toBe('gpt-5.6-luna');
    expect(chooseModel('claude-code', ['claude-haiku-4-5', 'claude-opus-4-6'])).toBe(
      'claude-opus-4-6',
    );
  });

  it('never falls back to a model that cannot write code', () => {
    // The provider list is alphabetical, so the naive first-element fallback would pick
    // the audio model and the agent would fail confusingly.
    expect(chooseModel('codex', ['gpt-4o-audio-preview', 'gpt-image-2', 'gpt-9-future'])).toBe(
      'gpt-9-future',
    );
  });

  it('returns null when the provider advertises nothing', () => {
    expect(chooseModel('codex', [])).toBeNull();
  });
});

describe('manyfoldEnvironment', () => {
  it('pairs each API host with the web console that owns its tokens', () => {
    expect(manyfoldEnvironment('https://api.manyfold.ai')).toMatchObject({
      apiHost: 'api.manyfold.ai',
      tokenPageUrl: 'https://manyfold.ai/settings/api-tokens',
    });
    expect(manyfoldEnvironment('https://api-staging.manyfold.ai')).toMatchObject({
      apiHost: 'api-staging.manyfold.ai',
      tokenPageUrl: 'https://app-staging.manyfold.ai/settings/api-tokens',
    });
  });

  it('defaults to production and tolerates a trailing slash', () => {
    expect(manyfoldEnvironment(undefined).apiHost).toBe('api.manyfold.ai');
    expect(manyfoldEnvironment('https://api-staging.manyfold.ai/').apiHost).toBe(
      'api-staging.manyfold.ai',
    );
  });
});

describe('manyfoldEnvironment web base', () => {
  it('gives the console root each environment deep-links into', () => {
    expect(manyfoldEnvironment('https://api.manyfold.ai').webBaseUrl).toBe('https://manyfold.ai');
    expect(manyfoldEnvironment('https://api-staging.manyfold.ai').webBaseUrl).toBe(
      'https://app-staging.manyfold.ai',
    );
  });
});
