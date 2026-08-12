/**
 * The setup orchestration: everything between "the user pasted a token" and "the agent is
 * ready to develop the app".
 *
 * This is the part of the product that has to be *deterministic*. Every step here is a
 * plain API call on the user's account token — no agent turns, no LLM in the loop, nothing
 * that bills the user — except the final bootstrap, which runs exactly one turn and says
 * so in the UI. That split is the whole reason the launcher exists: the setup that used to
 * be a scavenger hunt across the Manyfold UI is a sequence of verified calls.
 *
 * The sequence, and why each piece is where it is:
 *
 *   provisionAgent   create → set model → install skill → expose → mint caller token
 *   linkRepository   link the GitHub connection, then record the chosen repo
 *   bootstrapAgent   one A2A turn that makes the agent prove it can actually clone and push
 */

import type { Env } from './types';
import { HttpError } from './types';
import {
  ManyfoldClient,
  pickProvider,
  providerModels,
  toHttpError,
  type Framework,
  type ManyfoldAgent,
} from './manyfold';
import { probeAgentAuth } from './a2a';
import {
  requireProject,
  storeChatCredential,
  updateProject,
  type ProjectRow,
} from './projects';

/**
 * The harness skill that teaches the agent this template's engineering conventions.
 *
 * A GitHub URL rather than a `github:owner/repo@ref:path` id, because installing needs the
 * skill to exist in the account's library first — see `installHarnessSkill`.
 */
const HARNESS_SKILL_URL =
  'https://github.com/manyfold-open/manyfold-launch/tree/main/skills/cf-starter-dev';

/** Conversation credentials are rotated rather than renewed; 90 days is one product cycle. */
const CALLER_TOKEN_DAYS = 90;

const CALLER_NAME = 'Manyfold Launch';

/** Preference order when the account offers several models on the same provider. */
const MODEL_PREFERENCE: Record<Framework, string[]> = {
  codex: ['gpt-5.6-luna', 'gpt-5.6', 'gpt-5.5'],
  'claude-code': ['claude-opus-4-6', 'claude-opus-4-5-20251101', 'claude-haiku-4-5'],
  'gemini-cli': ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3.5-flash'],
};

/**
 * Models that cannot drive a coding agent. The provider list is alphabetical, so without
 * this the fallback below would hand someone `gpt-4o-audio-preview` and the agent would
 * fail in a thoroughly confusing way.
 */
const NON_TEXT_MODEL = /(image|audio|realtime|tts|whisper|embed)/i;

export interface AgentOption {
  agentId: string;
  name: string;
  framework: string;
  status: string;
  /** Connections can only be injected on sandbox runtimes, so anything else is unusable. */
  eligible: boolean;
}

export interface ProviderOption {
  providerId: string;
  name: string;
  framework: Framework;
  models: string[];
  /**
   * The model this provider would actually be configured with. Computed here rather than
   * in the UI: the wizard showing a different model than provisioning picks is the kind of
   * small lie that costs trust the first time someone notices.
   */
  preferredModel: string | null;
}

/**
 * What step 3 can offer this account: existing agents to adopt, and providers that make
 * zero-key creation possible.
 */
export async function agentOptions(
  client: ManyfoldClient,
): Promise<{ agents: AgentOption[]; providers: ProviderOption[] }> {
  const [agents, providers] = await Promise.all([
    client.listAgents().catch((error) => {
      throw toHttpError(error, 'Could not list your agents');
    }),
    client.listModelProviders().catch(() => []),
  ]);

  const frameworks: Framework[] = ['codex', 'claude-code', 'gemini-cli'];
  const providerOptions: ProviderOption[] = [];
  for (const framework of frameworks) {
    const provider = pickProvider(providers, framework);
    if (provider) {
      const models = providerModels(provider);
      providerOptions.push({
        providerId: provider.id,
        name: provider.providerName,
        framework,
        models,
        preferredModel: chooseModel(framework, models),
      });
    }
  }

  return {
    agents: agents.map((agent) => ({
      agentId: agent.id,
      name: agent.name,
      framework: agent.framework,
      status: agent.status,
      eligible: agent.runtime === 'sprites',
    })),
    providers: providerOptions,
  };
}

export function chooseModel(framework: Framework, models: string[]): string | null {
  for (const preferred of MODEL_PREFERENCE[framework]) {
    if (models.includes(preferred)) return preferred;
  }
  // Unknown provider or a newer catalogue than this list knows about: take the first model
  // that could plausibly write code rather than the first one alphabetically.
  return models.find((model) => !NON_TEXT_MODEL.test(model)) ?? models[0] ?? null;
}

/**
 * Creates or adopts an agent and leaves it ready to talk.
 *
 * On the create path this is a compound operation with no transaction behind it, so it
 * cleans up after itself: if anything after `createAgent` fails, the half-built agent is
 * deleted (which cascades to its skills and A2A grants) rather than left for the user to
 * find and wonder about. An adopted agent is never deleted — it was not ours to begin with.
 */
export async function provisionAgent(
  env: Env,
  client: ManyfoldClient,
  userId: string,
  projectId: string,
  input:
    | { mode: 'create'; name: string; framework: Framework; providerId?: string; apiKey?: string }
    | { mode: 'adopt'; agentId: string },
): Promise<ProjectRow> {
  const project = await requireProject(env, userId, projectId);

  let agent: ManyfoldAgent;
  let created = false;

  if (input.mode === 'adopt') {
    agent = await client.getAgent(input.agentId).catch((error) => {
      throw toHttpError(error, 'Could not read that agent');
    });
    if (agent.runtime !== 'sprites') {
      throw new HttpError(
        400,
        'agent_not_eligible',
        `"${agent.name}" runs on a ${agent.runtime} runtime. GitHub credentials can only be injected into sandbox runtimes, so this agent cannot develop the repo.`,
      );
    }
  } else {
    if (!input.providerId && !input.apiKey) {
      throw new HttpError(
        400,
        'no_credentials',
        'Creating an agent needs either one of your account model providers or an API key.',
      );
    }
    agent = await client
      .createAgent({
        name: input.name,
        framework: input.framework,
        providerId: input.providerId,
        apiKey: input.apiKey,
      })
      .catch((error) => {
        throw toHttpError(error, 'Could not create the agent');
      });
    created = true;
  }

  try {
    // A freshly created agent has no model, and a turn against it fails with
    // "Codex model is required" — so this is part of provisioning, not a nicety.
    if (input.mode === 'create' && !agent.model) {
      const providers = await client.listModelProviders().catch(() => []);
      const provider = providers.find((candidate) => candidate.id === input.providerId);
      const model = chooseModel(input.framework, provider ? providerModels(provider) : []);
      if (model) await client.setModel(agent.id, model);
    }

    // Best-effort: a missing harness skill degrades the agent's judgement about this
    // template but does not stop it from working, and the bootstrap turn reports it.
    await installHarnessSkill(client, agent.id);

    await client.setExposure(agent.id, true);
    const caller = await client.mintCallerToken(agent.id, CALLER_NAME, CALLER_TOKEN_DAYS);

    const updated = await storeChatCredential(env, userId, project.id, {
      rpcUrl: caller.rpcUrl,
      token: caller.token,
      tokenId: caller.tokenId,
      expiresAt: caller.expiresAt,
      agentName: agent.name,
    });

    // Non-billing reachability check: tasks/get on an id that cannot exist. Never
    // message/send, which would run — and charge for — a real turn.
    await probeAgentAuth({ rpcUrl: caller.rpcUrl, token: caller.token, label: agent.name }).catch(
      (error) => {
        throw new HttpError(
          502,
          'agent_unreachable',
          `The agent was set up but did not answer: ${String(error instanceof Error ? error.message : error)}`,
        );
      },
    );

    return updateProject(env, userId, updated.id, {
      agent_id: agent.id,
      agent_name: agent.name,
      setup_state: 'github',
    });
  } catch (error) {
    if (created) {
      await client.deleteAgent(agent.id).catch(() => undefined);
    }
    throw error instanceof HttpError ? error : toHttpError(error, 'Could not finish agent setup');
  }
}

/**
 * Puts the harness skill on the agent: import into the account's library, then install the
 * resulting library id.
 *
 * Deliberately swallows failures. The agent still works without the skill — it just has to
 * rediscover this template's conventions from `AGENTS.md` — and taking the whole setup down
 * over a skill that the readiness check will report on anyway would be the wrong trade.
 */
async function installHarnessSkill(client: ManyfoldClient, agentId: string): Promise<void> {
  try {
    const imported = await client.importSkillFromGithub(HARNESS_SKILL_URL);
    const skillId = imported?.skill?.id;
    if (skillId) await client.installSkill(agentId, skillId);
  } catch {
    /* see the note above: not fatal */
  }
}

/** Step 4: give the agent git credentials, and record which repo it is responsible for. */
export async function linkRepository(
  env: Env,
  client: ManyfoldClient,
  userId: string,
  projectId: string,
  input: { connectionId: string; repoFullName: string },
): Promise<ProjectRow> {
  const project = await requireProject(env, userId, projectId);
  if (!project.agent_id) {
    throw new HttpError(400, 'agent_missing', 'Set up the agent before linking a repository.');
  }

  await client.linkGithubConnection(project.agent_id, input.connectionId).catch((error) => {
    throw toHttpError(error, 'Could not link that GitHub connection');
  });

  return updateProject(env, userId, projectId, {
    connection_id: input.connectionId,
    repo_full_name: input.repoFullName,
    setup_state: 'bootstrap',
  });
}

/**
 * The bootstrap prompt: the one place the launcher spends the user's money.
 *
 * It asks for a checklist rather than a summary because the failure modes are specific and
 * the user needs to know *which* one hit — a missing GitHub App scope and a red test suite
 * both look like "it did not work" otherwise.
 */
export function bootstrapPrompt(project: ProjectRow): string {
  const repo = project.repo_full_name ?? 'the repository linked to your GitHub connection';
  const url = project.worker_url ?? '(the user has not shared the URL yet)';
  return [
    `You are now the development agent for ${repo}, a Cloudflare Workers app deployed at ${url}.`,
    '',
    'Run this checklist and report it back verbatim, one line per item, each marked OK or FAILED:',
    `1. Clone ${repo} into your workspace (or pull, if you already have it).`,
    '2. Read AGENTS.md in the repo root, plus the cf-starter-dev skill if it is installed.',
    '3. Verify write access with `git push --dry-run` — do not push anything.',
    '4. Run `npm ci` then `npm test`, and report whether the suite is green.',
    '',
    'For any FAILED item, include the raw error output. Do not fix anything yet, do not',
    'change any file, and do not push. This is a readiness check only.',
  ].join('\n');
}

/** Marks setup finished and records what the agent reported. */
export async function completeBootstrap(
  env: Env,
  userId: string,
  projectId: string,
  report: string,
): Promise<ProjectRow> {
  return updateProject(env, userId, projectId, {
    bootstrap_report: report,
    setup_state: 'done',
  });
}
