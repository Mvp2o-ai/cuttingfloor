import { withAuth } from '@workos-inc/authkit-nextjs';
import { customerFor, stripe } from '../../lib/billing.ts';

// Change the saved card or see receipts: Stripe's portal, with cuttingfloor's own configuration.
export async function POST(request: Request) {
  const { user } = await withAuth();
  const origin = new URL(request.url).origin;
  if (!user) return Response.redirect(`${origin}/account`, 303);
  const session = await stripe('/v1/billing_portal/sessions', {
    customer: await customerFor(user.id),
    return_url: `${origin}/account#credits`,
    ...(process.env.STRIPE_PORTAL_CONFIG
      ? { configuration: process.env.STRIPE_PORTAL_CONFIG }
      : {}),
  });
  return Response.redirect(String(session.url), 303);
}
