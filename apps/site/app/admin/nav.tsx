import { AppNav, STAFF_LINKS } from '../app-ui.tsx';

/** The staff pages' bar: Accounts, your own account, the signed-in email and Sign out. */
export function AdminNav({ email }: { email: string }) {
  return <AppNav email={email} links={STAFF_LINKS} current="/admin" />;
}
