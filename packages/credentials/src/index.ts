/**
 * Provider credentials (bring your own key). Rules, from plans/spec.md §12:
 * - no key ever passes through a tool argument, result, error, log or project file;
 * - keys are per provider, validated on save, resolved when a job starts;
 * - local mode keeps them in the OS keychain; hosted mode encrypts them per tenant.
 */
export type ProviderId =
  | 'typesafe'
  | 'elevenlabs'
  | 'deepgram'
  | 'assemblyai'
  | 'openai'
  | 'cartesia'
  | 'stability'
  | 'google'
  | 'bfl';

/** Environment variable each provider's key is read from in local mode. */
export const PROVIDER_ENV: Record<ProviderId, string> = {
  typesafe: 'TYPESAFE_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
  assemblyai: 'ASSEMBLYAI_API_KEY',
  openai: 'OPENAI_API_KEY',
  cartesia: 'CARTESIA_API_KEY',
  stability: 'STABILITY_API_KEY',
  google: 'GOOGLE_API_KEY',
  bfl: 'BFL_API_KEY',
};

export type CredentialStatus = { configured: boolean; status?: 'ok' | 'invalid' };

export interface CredentialStore {
  status(owner: string, provider: ProviderId): Promise<CredentialStatus>;
  /** For the server's own provider calls only; never returned to an MCP client. */
  resolve(owner: string, provider: ProviderId): Promise<string | undefined>;
  set(owner: string, provider: ProviderId, key: string): Promise<void>;
  remove(owner: string, provider: ProviderId): Promise<void>;
}

/**
 * Reads keys from the environment only. The daemon's store layers the OS keychain
 * (@napi-rs/keyring) on top; `cuttingfloor keys set` writes there.
 */
export class EnvCredentialStore implements CredentialStore {
  readonly #env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#env = env;
  }

  async status(_owner: string, provider: ProviderId): Promise<CredentialStatus> {
    return { configured: Boolean(this.#env[PROVIDER_ENV[provider]]) };
  }

  async resolve(_owner: string, provider: ProviderId): Promise<string | undefined> {
    return this.#env[PROVIDER_ENV[provider]] || undefined;
  }

  async set(): Promise<void> {
    throw new Error('Environment keys are read-only; use `cuttingfloor keys set <provider>`.');
  }

  async remove(): Promise<void> {
    throw new Error('Environment keys are read-only; unset the variable.');
  }
}
