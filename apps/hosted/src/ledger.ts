// The credit ledger, which Kazi keeps for both products: one balance per person, whichever site
// they buy on or spend on. cuttingfloor links an account to it once (carrying the balance it had
// here), reads the balance, reports each finished job's credits, and sets automatic top-up, which
// the ledger runs. Packs bought on our site reach the ledger through Stripe, not through us.
// Server to server, with a bearer key whose hash Kazi holds.

/** An account in the ledger, as every call that names one answers. */
export interface LedgerAccount {
  account_id: string;
  balance: number;
  granted_total: number;
  /** The balance carried over from before the ledger, signed. */
  opening_total: number;
  bought_total: number;
  used_total: number;
  /** A Kazi member with lifetime or staff: cuttingfloor gives it lifetime instead of a balance. */
  unmetered: boolean;
  refill: { pack: string } | null;
}

/** What the ledger did with a job's credits. */
export interface LedgerUsage {
  balance: number;
  /** The same job was reported before; nothing changed. */
  duplicate: boolean;
  /** The line this report took the balance across: below LOW_CREDITS, or to zero. */
  crossed: 'low' | 'out' | null;
  /** What automatic top-up did at the crossing, when it is on. */
  top_up:
    | {
        ok: true;
        pack: string;
        credits: number;
        price: number;
        card: { brand: string; last4: string };
        balance: number;
      }
    | { ok: false; pack: string; credits: number; price: number; message: string }
    | null;
}

/** The ledger refused to link: the email belongs to another of our accounts. */
export class LedgerConflict extends Error {}

/** The ledger has no account by that id (it was removed): link again. */
export class LedgerMissing extends Error {}

export class Ledger {
  #url: string;
  #key: string;

  constructor(url: string, key: string) {
    this.#url = url.replace(/\/$/, '');
    this.#key = key;
  }

  /** Finds or makes the account, carrying `opening` the first time; repeats change nothing else. */
  account(body: {
    email: string;
    workos_user_id: string;
    stripe_customer_id?: string;
    opening?: { credits: number; purchases: { payment_intent: string; credits: number }[] };
  }): Promise<LedgerAccount> {
    return this.#call('POST', '/api/credits/account', body);
  }

  balance(accountId: string): Promise<LedgerAccount> {
    return this.#call('GET', `/api/credits/balance?account_id=${encodeURIComponent(accountId)}`);
  }

  /** Spends a job's credits, once per job however often it is sent. */
  usage(body: {
    account_id: string;
    job_id: string;
    credits: number;
    tool: string;
    finished_at: string;
  }): Promise<LedgerUsage> {
    return this.#call('POST', '/api/credits/usage', body);
  }

  /** The pack bought on its own when the balance runs low, or null for off. */
  refill(accountId: string, pack: string | null): Promise<LedgerAccount> {
    return this.#call('PUT', '/api/credits/refill', { account_id: accountId, pack });
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
    if (res.status === 409) throw new LedgerConflict(out.error ?? 'link conflict');
    if (res.status === 404) throw new LedgerMissing(out.error ?? 'no such account');
    if (!res.ok) throw new Error(`ledger ${method} ${path.split('?')[0]}: ${res.status}`);
    return out;
  }
}
