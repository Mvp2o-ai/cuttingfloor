import { ADMIN_SORTS } from '@cuttingfloor/schema';
import { withAuth } from '@workos-inc/authkit-nextjs';
import { notFound } from 'next/navigation';
import { type AdminSort, isStaff, listAccounts } from '../lib/admin.ts';
import { AdminNav } from './nav.tsx';
import { AccountsView } from './view.tsx';

// Staff only: every cuttingfloor account, searchable and sortable, from the hosted server's admin
// API. Staff are the accounts the server's rights table makes admins (scripts/grant-role.ts);
// anyone else signed in gets a 404, as if there were no page.

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Accounts — cuttingfloor staff', robots: { index: false } };

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string; page?: string }>;
}) {
  const { user } = await withAuth({ ensureSignedIn: true });
  if (!(await isStaff(user.id))) notFound();
  const params = await searchParams;
  const q = (params.q ?? '').trim().slice(0, 200);
  const sort = (ADMIN_SORTS as readonly string[]).includes(params.sort ?? '')
    ? (params.sort as AdminSort)
    : 'newest';
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);
  const list = await listAccounts(user.id, { q, sort, page });
  return (
    <>
      <AdminNav email={user.email} />
      <AccountsView
        q={q}
        sort={sort}
        {...(list.ok ? { list: list.body } : { error: list.message })}
      />
    </>
  );
}
