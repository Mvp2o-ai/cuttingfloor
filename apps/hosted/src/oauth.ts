import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';

/** RFC 8414 metadata, as the SDK's `oauthMetadataResponse` serves it. */
export type AuthorizationServerMetadata = Record<string, unknown> & {
  issuer: string;
  jwks_uri?: string;
};

/**
 * The one piece of MCP authorization the SDK leaves to the server: checking an access token.
 * Tokens are JWTs from one authorization server (WorkOS AuthKit), checked here against its
 * published keys and issuer. The SDK does the rest: `requireBearerAuth` checks the audience
 * (RFC 8707) and expiry and answers with the 401 challenge, and `oauthMetadataResponse` serves
 * the discovery documents.
 */
export class JwtTokenVerifier implements OAuthTokenVerifier {
  metadata: AuthorizationServerMetadata;
  #keys: { uri: string; get: JWTVerifyGetKey };

  constructor(metadata: AuthorizationServerMetadata) {
    this.metadata = metadata;
    this.#keys = keysFor(metadata);
  }

  /** Takes fresh metadata, e.g. after registration settings change at the server. */
  update(metadata: AuthorizationServerMetadata): void {
    if (metadata.issuer !== this.metadata.issuer)
      throw new Error(`issuer changed from ${this.metadata.issuer} to ${metadata.issuer}`);
    this.metadata = metadata;
    if (metadata.jwks_uri !== this.#keys.uri) this.#keys = keysFor(metadata);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const { payload } = await jwtVerify(token, this.#keys.get, {
        issuer: this.metadata.issuer,
        requiredClaims: ['exp', 'sub'],
        clockTolerance: 30,
      });
      const audience = [payload.aud ?? []].flat()[0];
      return {
        token,
        clientId: String(payload.client_id ?? payload.azp ?? ''),
        scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
        expiresAt: payload.exp as number,
        ...(audience ? { resource: new URL(audience) } : {}),
        extra: { sub: payload.sub },
      };
    } catch {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is invalid or expired');
    }
  }
}

function keysFor(metadata: AuthorizationServerMetadata) {
  if (typeof metadata.jwks_uri !== 'string')
    throw new Error(`${metadata.issuer} publishes no jwks_uri`);
  return { uri: metadata.jwks_uri, get: createRemoteJWKSet(new URL(metadata.jwks_uri)) };
}

/** Fetches an authorization server's metadata (RFC 8414, else OpenID discovery). */
export async function discoverAuthorizationServer(
  issuer: string,
): Promise<AuthorizationServerMetadata> {
  const { origin, pathname } = new URL(issuer);
  const path = pathname === '/' ? '' : pathname.replace(/\/$/, '');
  for (const url of [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}/.well-known/openid-configuration${path}`,
  ]) {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    if (!res?.ok) continue;
    const metadata = (await res.json().catch(() => undefined)) as
      | AuthorizationServerMetadata
      | undefined;
    if (typeof metadata?.issuer !== 'string') continue;
    if (metadata.issuer.replace(/\/$/, '') !== issuer.replace(/\/$/, ''))
      throw new Error(`${url} names issuer ${metadata.issuer}, not ${issuer}`);
    return metadata;
  }
  throw new Error(`no authorization server metadata found for ${issuer}`);
}
