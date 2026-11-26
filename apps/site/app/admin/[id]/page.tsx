import { withAuth } from '@workos-inc/authkit-nextjs';
import { notFound } from 'next/navigation';
import { getAccount, getLedger, isStaff } from '../../lib/admin.ts';
import { AdminNav } from '../nav.tsx';
import { AccountDetail } from '../view.tsx';

// Staff only: one account, its ledger, and the form that adjusts its credits.

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Account — cuttingfloor staff', robots: { index: false } };

export default async function AdminAccountPage({ params }: { params: Promise<{ id: string }> }) {
  // Only an account id is a page (and only those paths get a session: proxy.ts).
  const { id } = await params;
  if (!/^user_[0-9A-Z]{26}$/.test(id)) notFound();
  const { user } = await withAuth({ ensureSignedIn: true });
  if (!(await isStaff(user.id))) notFound();
  const [account, ledger] = await Promise.all([getAccount(user.id, id), getLedger(user.id, id)]);
  if (!account.ok) {
    if (account.status === 404) notFound();
    throw new Error(`The account could not be read: ${account.message}`);
  }
  return (
    <>
      <AdminNav email={user.email} />
      <AccountDetail
        account={account.body}
        {...(ledger.ok ? { ledger: ledger.body } : { ledgerError: ledger.message })}
      />
    </>
  );
}
