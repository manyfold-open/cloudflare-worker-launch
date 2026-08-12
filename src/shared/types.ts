/**
 * Types shared between the Worker (src/worker) and the browser app (src/app).
 * Everything here is part of the JSON API surface, so keep it serializable
 * and free of runtime imports from either side.
 *
 * Note what is absent: no token, no ciphertext, no device code. Credentials are
 * write-only from the browser's point of view, and keeping them out of this file is how
 * that stays true.
 */

/** Wizard progress. The order is the order the steps run in. */
export type SetupState = 'deploy' | 'auth' | 'agent' | 'github' | 'bootstrap' | 'done';

/** One launch project, as exposed to the browser. */
export interface ProjectView {
  id: string;
  template: string;
  workerUrl: string | null;
  repoFullName: string | null;
  connectionId: string | null;
  agentId: string | null;
  agentName: string | null;
  /** Is a conversation credential stored? The credential itself never leaves the Worker. */
  hasCredential: boolean;
  credentialExpiresAt: string | null;
  setupState: SetupState;
  bootstrapReport: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An agent the account already owns, offered for adoption in step 3. */
export interface AgentOptionView {
  agentId: string;
  name: string;
  framework: string;
  status: string;
  /** False for non-sandbox runtimes, which cannot receive GitHub credentials. */
  eligible: boolean;
}

/** A model provider that makes zero-key agent creation possible. */
export interface ProviderOptionView {
  providerId: string;
  name: string;
  framework: string;
  models: string[];
  /** The model provisioning will actually configure, so the UI can promise the same thing. */
  preferredModel: string | null;
}

export interface ConnectionView {
  id: string;
  provider: string;
  displayName: string;
  manageUrl: string | null;
}

export interface RepoView {
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
}

/** Bootstrap payload: everything the SPA needs to render its first frame. */
export interface AppState {
  service: string;
  /** Has this browser session been bound to a Manyfold account? */
  connected: boolean;
  /** Is the management token still held, or was it dropped after setup? */
  hasManagementToken: boolean;
  projects: ProjectView[];
  /** The scopes the wizard asks for, so the UI and the server cannot drift apart. */
  requiredScopes: string[];
  /** The Manyfold environment this deployment talks to — tokens are not portable across them. */
  apiHost: string;
  /** Where to create a token for that specific environment. */
  tokenPageUrl: string;
  /** Root of the matching Manyfold web console, for deep links to an agent. */
  webBaseUrl: string;
  /** Where the user creates that token. */
  templateRepoUrl: string;
  deployButtonUrl: string;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'agent';
  content: string;
  status: 'complete' | 'error' | 'input-required';
  error: string | null;
  createdAt: string;
}

export interface ConversationInfo {
  contextId: string | null;
  activeTaskId: string | null;
}

/**
 * Events the Worker streams to the browser during a chat turn (SSE `data:` payloads).
 * `text` always carries the FULL accumulated reply — the client replaces, never appends,
 * so A2A artifact append/lastChunk semantics stay entirely server-side.
 */
export type ChatEvent =
  | { type: 'status'; state: string; taskId: string | null; contextId: string | null }
  | { type: 'text'; text: string }
  | { type: 'done'; state: string; text: string }
  | { type: 'error'; message: string };

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** Live status of a deployed project, for the console's status strip. */
export interface ProjectStatus {
  workerUrl: string | null;
  healthy: boolean | null;
  checkedAt: string;
  detail: string | null;
}
