import { withAuth } from '@workos-inc/authkit-nextjs';
import { accountOf, packFor, setMetadata } from '../../lib/billing.ts';

// Automatic top-up: the pack bought on the saved card when credits run low, or off. Kept on the
// WorkOS user (`refill_pack`), where the MCP server reads it.
export async function POST(request: Request) {
  const { user } = await withAuth();
  const origin = new URL(request.url).origin;
  if (!user) return Response.redirect(`${origin}/account`, 303);
  const form = await request.formData();
  const id = String(form.get('pack') ?? '');
  await setMetadata(user.id, { refill_pack: id ? packFor(id).id : '' });
  await accountOf(user.id, true);
  return Response.redirect(`${origin}/account#credits`, 303);
}
