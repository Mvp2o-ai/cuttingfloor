import { withAuth } from '@workos-inc/authkit-nextjs';
import { accountStatus, workos } from '../lib/billing.ts';
import { filesOf } from '../lib/files.ts';
import { keysOf } from '../lib/keys.ts';
import { providerKeysOf } from '../lib/provider-keys.ts';
import { AccountNav } from './chrome.tsx';
import { AccountView } from './view.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Account — cuttingfloor', robots: { index: false } };

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ bought?: string }>;
}) {
  const { user } = await withAuth({ ensureSignedIn: true });
  const { bought } = await searchParams;
  const [status, found, files, keys, providerKeys] = await Promise.all([
    accountStatus(user.id, Boolean(bought)),
    workos(`/user_management/users/${encodeURIComponent(user.id)}`).catch(() => ({})),
    filesOf(user.id),
    keysOf(user.id),
    providerKeysOf(user.id),
  ]);
  const metadata = ((found as { metadata?: unknown }).metadata ?? {}) as Record<string, string>;

  return (
    <>
      <AccountNav email={user.email} />
      <AccountView
        email={user.email}
        firstName={user.firstName}
        {...status}
        progress={{
          first_call_at: metadata.first_call_at,
          first_edit_at: metadata.first_edit_at,
          first_export_at: metadata.first_export_at,
        }}
        bought={bought && /^\d+$/.test(bought) ? bought : undefined}
        files={files}
        keys={keys}
        providerKeys={providerKeys}
        server={process.env.CUTTINGFLOOR_SERVER_URL ?? 'https://api.cuttingfloor.ai'}
      />
    </>
  );
}
