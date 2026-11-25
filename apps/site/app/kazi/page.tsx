import { withAuth } from '@workos-inc/authkit-nextjs';
import { redirect } from 'next/navigation';
import { isNew } from './link.ts';
import { Opening } from './opening.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Opening Kazi — cuttingfloor', robots: { index: false } };

// After sign-up on the site: straight into Kazi, signed in as themselves, with cuttingfloor
// connected to this account and the live demo open (no guest limit; it's their account). Accounts
// made on the site with no agent of their own did nothing at all, while those made inside an AI
// app got to work. The page answers at once and fetches the one-time link from /api/kazi-link
// (activation and Kazi take seconds, and a blank wait that long lost a sign-up); when Kazi can't
// answer, the welcome page that connects an agent, as before. Someone who signed in to an older
// account on the sign-up screen gets that page straight away: only a new account goes on.
export default async function Kazi() {
  const { user } = await withAuth({ ensureSignedIn: true });
  if (!isNew(user.createdAt)) redirect('/welcome');
  return (
    <main className="frame">
      <section className="cell marks">
        <span className="mark-b" />
        <span className="label">Welcome{user.firstName ? `, ${user.firstName}` : ''}</span>
        <h1 className="display account-head">Opening Kazi…</h1>
        <Opening />
      </section>
    </main>
  );
}
