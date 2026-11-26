import type { NewEntry } from './ledger.ts';

// What a cuttingfloor payment in Stripe adds to the ledger: the pack it bought (entry id the
// payment intent) and each refund of it (entry id the refund), a refund taking back its share of
// the pack. The Stripe account is shared with Kazi, so only payments whose metadata says
// `app: cuttingfloor` count, and each names its account (`workos_user_id`). The webhook, the
// account page's return from checkout, automatic top-up and the opening backfill all write these
// same entries, so whichever comes first counts and the rest change nothing.

export interface StripePaymentIntent {
  id: string;
  status: string;
  created?: number;
  amount_received?: number;
  currency?: string;
  customer?: string | null;
  metadata?: Record<string, string>;
  latest_charge?: string | { amount?: number; amount_refunded?: number } | null;
}

interface StripeRefund {
  id: string;
  amount: number;
  status: string;
  created: number;
}

export async function stripeGet<T = Record<string, unknown>>(
  key: string,
  path: string,
): Promise<T> {
  const res = await fetch(`https://api.stripe.com${path}`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Stripe ${path.split('?')[0]}: ${res.status}`);
  return (await res.json()) as T;
}

/** Whether a payment is a cuttingfloor pack that went through, and whose. */
export function ourPayment(
  pi: StripePaymentIntent,
): { owner: string; credits: number } | undefined {
  const credits = Number(pi.metadata?.credits);
  const owner = pi.metadata?.workos_user_id ?? '';
  if (pi.status !== 'succeeded' || pi.metadata?.app !== 'cuttingfloor') return undefined;
  if (!(credits > 0) || !/^user_[0-9A-Z]{26}$/.test(owner)) return undefined;
  return { owner, credits };
}

/** The entries a cuttingfloor payment makes: its pack, and its refunds so far. */
export async function paymentEntries(key: string, pi: StripePaymentIntent): Promise<NewEntry[]> {
  const ours = ourPayment(pi);
  if (!ours) return [];
  const pack = pi.metadata?.pack;
  const base = { payment_intent: pi.id, ...(pack ? { pack } : {}) };
  const out: NewEntry[] = [
    {
      id: pi.id,
      kind: 'purchase',
      credits: ours.credits,
      ...base,
      at: new Date((pi.created ?? Date.now() / 1000) * 1000).toISOString(),
    },
  ];
  const paid = pi.amount_received ?? 0;
  const refunds = await stripeGet<{ data?: StripeRefund[] }>(
    key,
    `/v1/refunds?payment_intent=${encodeURIComponent(pi.id)}&limit=100`,
  );
  for (const refund of refunds.data ?? []) {
    if (refund.status === 'failed' || refund.status === 'canceled' || !paid) continue;
    out.push({
      id: refund.id,
      kind: 'refund',
      credits: -Math.round(ours.credits * Math.min(1, refund.amount / paid) * 1000) / 1000,
      ...base,
      at: new Date(refund.created * 1000).toISOString(),
    });
  }
  return out;
}

/** One payment intent. */
export function paymentIntent(key: string, id: string): Promise<StripePaymentIntent> {
  return stripeGet<StripePaymentIntent>(key, `/v1/payment_intents/${encodeURIComponent(id)}`);
}

/** The customer's cuttingfloor payments that went through, newest first. */
export async function customerPayments(
  key: string,
  customer: string,
  options: { expandCharge?: boolean } = {},
): Promise<StripePaymentIntent[]> {
  const out: StripePaymentIntent[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const list = await stripeGet<{ data?: StripePaymentIntent[]; has_more?: boolean }>(
      key,
      `/v1/payment_intents?customer=${encodeURIComponent(customer)}&limit=100${options.expandCharge ? '&expand[]=data.latest_charge' : ''}${after ? `&starting_after=${after}` : ''}`,
    );
    const data = list.data ?? [];
    out.push(
      ...data.filter((pi) => pi.status === 'succeeded' && pi.metadata?.app === 'cuttingfloor'),
    );
    after = data.at(-1)?.id;
    if (!list.has_more || !after) break;
  }
  return out;
}
