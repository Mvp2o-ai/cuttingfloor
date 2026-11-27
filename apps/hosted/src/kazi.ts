// Kazi, cuttingfloor's sister product, over its partner API: the one-time link that takes someone
// who just signed up on our site on into Kazi. Nothing else: each product keeps its own credits
// (ours are ledger.ts) and its own activity. Server to server, with a bearer key whose hash Kazi
// holds.

/** Kazi refused the request's shape: sending it again won't help. */
export class KaziRefused extends Error {}

export class Kazi {
  #url: string;
  #key: string;

  constructor(url: string, key: string) {
    this.#url = url.replace(/\/$/, '');
    this.#key = key;
  }

  /**
   * A one-time link that opens Kazi signed in as this person, with cuttingfloor connected to this
   * same account, on the playbook share `share_code` (the same key, as both sides are ours).
   * `name` names a Kazi account made for them; one they already have keeps its own. `via` is the
   * AI app they came from (chatgpt, claude), so the demo leads with how to add cuttingfloor there.
   */
  handoff(body: {
    email: string;
    workos_user_id: string;
    share_code: string;
    name?: string;
    via?: string;
  }): Promise<{ url: string; expires_at: string }> {
    return this.#call('POST', '/api/partner/cuttingfloor/handoff', body);
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.#url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#key}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const out = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (res.status === 400) throw new KaziRefused(out.error ?? 'bad request');
    if (!res.ok) throw new Error(`Kazi ${method} ${path.split('?')[0]}: ${res.status}`);
    return out;
  }
}
