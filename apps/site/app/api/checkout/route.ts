import { withAuth } from '@workos-inc/authkit-nextjs';
import {
  buyOnSavedCard,
  customerFor,
  packFor,
  packMetadata,
  priceFor,
  stripe,
} from '../../lib/billing.ts';

// Buy a credit pack. With a card saved from an earlier pack it is one click: charged here and
// back to the account page. Otherwise (or when the bank wants the person to confirm) Stripe
// Checkout, which saves the card for next time and for automatic top-up. Link and wallets come
// with Checkout; Managed Payments (Stripe as merchant of record) once activated.
export async function POST(request: Request) {
  const { user } = await withAuth();
  const origin = new URL(request.url).origin;
  if (!user) return Response.redirect(`${origin}/account`, 303);
  const form = await request.formData();
  const pack = packFor(String(form.get('pack') ?? ''));
  const customer = await customerFor(user.id);
  // The form's nonce makes a double click one charge.
  const nonce = String(form.get('nonce') ?? '').slice(0, 64) || crypto.randomUUID();
  if (form.get('saved') === '1' && (await buyOnSavedCard(user.id, customer, pack, nonce)))
    return Response.redirect(`${origin}/account?bought=${pack.credits}#credits`, 303);
  const session = await stripe('/v1/checkout/sessions', {
    mode: 'payment',
    customer,
    client_reference_id: user.id,
    'line_items[0][price]': await priceFor(pack),
    'line_items[0][quantity]': '1',
    ...packMetadata(pack, user.id, 'payment_intent_data[metadata]'),
    'payment_intent_data[setup_future_usage]': 'off_session',
    allow_promotion_codes: 'true',
    ...(process.env.STRIPE_MANAGED_PAYMENTS === '1' ? { 'managed_payments[enabled]': 'true' } : {}),
    success_url: `${origin}/account?bought=${pack.credits}#credits`,
    cancel_url: `${origin}/account#credits`,
  });
  return Response.redirect(String(session.url), 303);
}
