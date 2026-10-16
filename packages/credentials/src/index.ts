import { readFile } from 'node:fs/promises';

/**
 * Provider credentials (bring your own key). Rules, from plans/spec.md §12:
 * - no key ever passes through a tool argument, result, error, log or stored file;
 * - keys are per provider and resolved when a job starts;
 * - local mode reads Docker secrets, then the environment; hosted mode takes them from the
 *   client's request headers and never stores them.
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

/** Environment variable (and Docker secret name, lower-cased) for each provider in local mode. */
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

export type CredentialStatus = { configured: boolean; source?: 'secret' | 'env' };

export interface CredentialStore {
  status(owner: string, provider: ProviderId): Promise<CredentialStatus>;
  /** For the server's own provider calls only; never returned to an MCP client. */
  resolve(owner: string, provider: ProviderId): Promise<string | undefined>;
}

/**
 * Local mode: Docker secrets (`/run/secrets/<env name lower-cased>`), then the environment
 * (`.env` next to compose.yaml). Single user, so `owner` is ignored.
 */
export class LocalCredentialStore implements CredentialStore {
  readonly #env: NodeJS.ProcessEnv;
  readonly #secrets: boolean;
  readonly #secretsDir: string;

  constructor(env: NodeJS.ProcessEnv = process.env, secrets = true, secretsDir = '/run/secrets') {
    this.#env = env;
    this.#secrets = secrets;
    this.#secretsDir = secretsDir;
  }

  async #lookup(
    provider: ProviderId,
  ): Promise<{ key: string; source: 'secret' | 'env' } | undefined> {
    const name = PROVIDER_ENV[provider];
    if (this.#secrets) {
      const secret = await readFile(`${this.#secretsDir}/${name.toLowerCase()}`, 'utf8').then(
        (s) => s.trim(),
        () => '',
      );
      if (secret) return { key: secret, source: 'secret' };
    }
    const env = this.#env[name]?.trim();
    return env ? { key: env, source: 'env' } : undefined;
  }

  async status(_owner: string, provider: ProviderId): Promise<CredentialStatus> {
    const found = await this.#lookup(provider);
    return found ? { configured: true, source: found.source } : { configured: false };
  }

  async resolve(_owner: string, provider: ProviderId): Promise<string | undefined> {
    return (await this.#lookup(provider))?.key;
  }
}
