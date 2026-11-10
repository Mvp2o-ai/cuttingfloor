// The card an account saved at its first checkout, which the account page shows; the ledger's
// automatic top-up and the site's one-click buy (apps/site/app/lib/billing.ts) charge it.

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
