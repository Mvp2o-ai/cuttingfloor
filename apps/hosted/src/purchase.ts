import type { Pack } from '@cuttingfloor/plans';

// Buying a credit pack on the card the account saved at its first checkout, with nobody at the
// screen: the automatic top-up. The site's one-click buy does the same with the person present
// (apps/site/app/lib/billing.ts). The payment's metadata is what the access check counts.

export interface Card {
  id: string;
  brand: string;
  last4: string;
}

/** The customer's most recently saved card, if any. */
export async function savedCard(stripeKey: string, customer: string): Promise<Card | undefined> {
  const res = await fetch(
    `https://api.stripe.com/v1/payment_methods?customer=${encodeURIComponent(customer)}&type=card&limit=1`,
    { headers: { authorization: `Bearer ${stripeKey}` }, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`Stripe ${res.status}`);
  const body = (await res.json()) as {
    data?: { id: string; card?: { brand?: string; last4?: string } }[];
  };
  const pm = body.data?.[0];
  return pm
    ? { id: pm.id, brand: pm.card?.brand ?? 'card', last4: pm.card?.last4 ?? '' }
    : undefined;
}

/**
 * Charges a pack to a saved card, off session. `key` makes a retry the same charge. Resolves to
 * whether it went through, with Stripe's reason when it didn't (declined, needs the person).
 */
export async function chargePack(
  stripeKey: string,
  o: { customer: string; owner: string; pack: Pack; card: Card; key: string; reason: string },
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const res = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${stripeKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': o.key,
    },
    body: new URLSearchParams({
      amount: String(Math.round(o.pack.price * 100)),
      currency: 'usd',
      customer: o.customer,
      payment_method: o.card.id,
      confirm: 'true',
      off_session: 'true',
      description: `cuttingfloor: ${o.pack.credits} credits`,
      'metadata[app]': 'cuttingfloor',
      'metadata[credits]': String(o.pack.credits),
      'metadata[pack]': o.pack.id,
      'metadata[workos_user_id]': o.owner,
      'metadata[reason]': o.reason,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as {
    id?: string;
    status?: string;
    error?: { message?: string };
  };
  if (res.ok && body.status === 'succeeded' && body.id) return { ok: true, id: body.id };
  return { ok: false, message: body.error?.message ?? `the payment is ${body.status}` };
}
