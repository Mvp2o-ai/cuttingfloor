import { withAuth } from '@workos-inc/authkit-nextjs';
import { workos } from '../../lib/billing.ts';

// For the welcome page: whether the signed-in account's agent has called the server yet. The MCP
// server records the first call in the account's WorkOS metadata.
export async function GET() {
  const { user } = await withAuth();
  if (!user) return Response.json({ error: 'signed out' }, { status: 401 });
  const record = await workos(`/user_management/users/${encodeURIComponent(user.id)}`);
  const metadata = (record.metadata ?? {}) as Record<string, string>;
  return Response.json(
    {
      first_call_at: metadata.first_call_at ?? null,
      first_export_at: metadata.first_export_at ?? null,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
