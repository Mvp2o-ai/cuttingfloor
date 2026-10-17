import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';

export interface OAuthOptions {
  /** The authorization server's issuer, e.g. https://example.authkit.app. */
  issuer: string;
  /** This server's canonical MCP URI (RFC 8707), e.g. https://mcp.example.com/mcp. */
  resource: string;
}

/**
 * The resource-server half of MCP authorization (2026-07-28): Protected Resource Metadata
 * (RFC 9728) pointing at one external authorization server, and access tokens checked as JWTs
 * against its keys, issuer and our own audience. Sign-in, consent, client registration (CIMD,
 * DCR) and tokens all live at the authorization server; this holds nothing but cached keys.
 */
export class OAuthVerifier {
  readonly issuer: string;
  readonly resource: string;
  readonly resourceMetadataUrl: string;
  #audiences: string[];
  #metadata: { value: Promise<Record<string, unknown>>; at: number } | undefined;
  #jwks?: { uri: string; keys: JWTVerifyGetKey };

  constructor(options: OAuthOptions) {
    this.issuer = options.issuer.replace(/\/$/, '');
    this.resource = options.resource.replace(/\/$/, '');
    const url = new URL(this.resource);
    this.resourceMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource${url.pathname === '/' ? '' : url.pathname}`;
    // Clients name the most specific URI they can; some name the origin alone.
    this.#audiences = [this.resource, `${this.resource}/`, url.origin, `${url.origin}/`];
  }

  /** The RFC 9728 document served at resourceMetadataUrl (and the root well-known path). */
  protectedResource(): Record<string, unknown> {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      bearer_methods_supported: ['header'],
      resource_name: 'cuttingfloor',
    };
  }

  /** The 401 challenge: where to find the metadata, and why the token failed if one came. */
  challenge(tokenSent: boolean): string {
    const error = tokenSent
      ? ', error="invalid_token", error_description="The access token is invalid or expired"'
      : '';
    return `Bearer resource_metadata="${this.resourceMetadataUrl}"${error}`;
  }

  /**
   * The authorization server's metadata (RFC 8414, else OpenID discovery), cached for five
   * minutes as AuthKit caches it, so a registration setting changed there shows soon.
   */
  async authorizationServerMetadata(): Promise<Record<string, unknown>> {
    if (this.#metadata && Date.now() - this.#metadata.at < 300_000) return this.#metadata.value;
    const value = this.#discover();
    this.#metadata = { value, at: Date.now() };
    value.catch(() => {
      if (this.#metadata?.value === value) this.#metadata = undefined;
    });
    return value;
  }

  /** The owner a valid access token acts as (its `sub`), or undefined. */
  async verify(token: string): Promise<string | undefined> {
    if (token.split('.').length !== 3) return undefined;
    let keys: JWTVerifyGetKey;
    try {
      keys = await this.#keys();
    } catch (error) {
      process.stderr.write(`oauth: ${(error as Error).message}\n`);
      return undefined;
    }
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: [this.issuer, `${this.issuer}/`],
        audience: this.#audiences,
        requiredClaims: ['exp', 'sub'],
        clockTolerance: 30,
      });
      return typeof payload.sub === 'string' && payload.sub ? payload.sub : undefined;
    } catch {
      return undefined;
    }
  }

  async #keys(): Promise<JWTVerifyGetKey> {
    const uri = (await this.authorizationServerMetadata()).jwks_uri;
    if (typeof uri !== 'string') throw new Error(`${this.issuer} publishes no jwks_uri`);
    if (this.#jwks?.uri !== uri) this.#jwks = { uri, keys: createRemoteJWKSet(new URL(uri)) };
    return this.#jwks.keys;
  }

  async #discover(): Promise<Record<string, unknown>> {
    const { origin, pathname } = new URL(this.issuer);
    const path = pathname === '/' ? '' : pathname;
    const candidates = [
      `${origin}/.well-known/oauth-authorization-server${path}`,
      `${origin}/.well-known/openid-configuration${path}`,
      `${this.issuer}/.well-known/openid-configuration`,
    ];
    for (const url of candidates) {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      if (!res?.ok) continue;
      const metadata = (await res.json().catch(() => undefined)) as
        | Record<string, unknown>
        | undefined;
      if (typeof metadata?.issuer !== 'string') continue;
      if (metadata.issuer.replace(/\/$/, '') !== this.issuer)
        throw new Error(`${url} names issuer ${metadata.issuer}, not ${this.issuer}`);
      return metadata;
    }
    throw new Error(`no authorization server metadata found for ${this.issuer}`);
  }
}
