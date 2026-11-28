import { withAuth } from '@workos-inc/authkit-nextjs';
import { AppNav, accountLinks } from '../app-ui.tsx';
import { accountStatus, creditPayment, workos } from '../lib/billing.ts';
import { filesOf } from '../lib/files.ts';
import { keysOf } from '../lib/keys.ts';
import { providerKeysOf } from '../lib/provider-keys.ts';
import { AccountView } from './view.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Account — cuttingfloor', robots: { index: false } };

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ bought?: string; session?: string }>;
}) {
  const { user } = await withAuth({ ensureSignedIn: true });
  const { bought, session } = await searchParams;
  // Back from checkout: credited now, before the balance is read (the server takes only the
  // signed-in user's own payment, once).
  if (session && /^cs_[A-Za-z0-9_]{1,250}$/.test(session))
    await creditPayment(user.id, { checkout_session: session });
  const [status, found, files, keys, adminKeys, providerKeys] = await Promise.all([
    accountStatus(user.id, Boolean(bought)),
    workos(`/user_management/users/${encodeURIComponent(user.id)}`).catch(() => ({})),
    filesOf(user.id),
    keysOf(user.id),
    keysOf(user.id, 'admin'),
    providerKeysOf(user.id),
  ]);
  const metadata = ((found as { metadata?: unknown }).metadata ?? {}) as Record<string, string>;

  return (
    <AccountView
      nav={
        <AppNav email={user.email} links={accountLinks(Boolean(adminKeys))} current="/account" />
      }
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
      adminKeys={adminKeys}
      providerKeys={providerKeys}
      expiryEmails={metadata.expiry_emails !== 'off'}
      server={process.env.CUTTINGFLOOR_SERVER_URL ?? 'https://api.cuttingfloor.ai'}
    />
  );
}
