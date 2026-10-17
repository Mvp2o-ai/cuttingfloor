import { withAuth } from '@workos-inc/authkit-nextjs';
import { customerFor, priceFor, stripe } from '../../lib/billing.ts';

// Subscribe: Stripe Checkout for one of our prices, on the user's own Stripe customer. Link and
// wallets come with Checkout; Managed Payments (Stripe as merchant of record) once activated.
export async function POST(request: Request) {
  const { user } = await withAuth();
  const origin = new URL(request.url).origin;
  if (!user) return Response.redirect(`${origin}/account`, 303);
  const form = await request.formData();
  const price = await priceFor(String(form.get('plan') ?? ''));
  const customer = await customerFor(user.id);
  const session = await stripe('/v1/checkout/sessions', {
    mode: 'subscription',
    customer,
    client_reference_id: user.id,
    'line_items[0][price]': price,
    'line_items[0][quantity]': '1',
    'subscription_data[metadata][workos_user_id]': user.id,
    'subscription_data[metadata][app]': 'cuttingfloor',
    allow_promotion_codes: 'true',
    ...(process.env.STRIPE_MANAGED_PAYMENTS === '1' ? { 'managed_payments[enabled]': 'true' } : {}),
    success_url: `${origin}/account?subscribed=1`,
    cancel_url: `${origin}/account`,
  });
  return Response.redirect(String(session.url), 303);
}
