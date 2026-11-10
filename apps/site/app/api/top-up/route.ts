import { withAuth } from '@workos-inc/authkit-nextjs';
import { packFor, setTopUp } from '../../lib/billing.ts';

// Automatic top-up: the pack bought on the saved card when credits run low, or off. The MCP server
// passes it to the credit ledger, which keeps it and buys the pack.
export async function POST(request: Request) {
  const { user } = await withAuth();
  const origin = new URL(request.url).origin;
  if (!user) return Response.redirect(`${origin}/account`, 303);
  const form = await request.formData();
  const id = String(form.get('pack') ?? '');
  await setTopUp(user.id, id ? packFor(id).id : null);
  return Response.redirect(`${origin}/account#credits`, 303);
}
