import { withAuth } from '@workos-inc/authkit-nextjs';
import { FilesPanel } from '../account/files.tsx';
import { AppNav, AppPage, accountLinks, Card } from '../app-ui.tsx';
import { isStaff } from '../lib/admin.ts';
import { filesOf } from '../lib/files.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Upload — cuttingfloor', robots: { index: false } };

// Where a user drops files for their AI to use: the files and nothing else, so tools and
// instructions can link here (the account page also sells credits).
export default async function UploadPage() {
  const { user } = await withAuth({ ensureSignedIn: true });
  const files = await filesOf(user.id);
  return (
    <AppPage
      nav={
        <AppNav
          email={user.email}
          links={accountLinks((await isStaff(user.id)) === true)}
          current="/upload"
        />
      }
      title="Files"
      sub="Your footage, music, logos and photos: add them here and your AI can use them. Tell it the file’s name, for example “cut the pauses out of interview.mp4”."
    >
      <Card id="files">
        {files ? (
          <FilesPanel initial={files} />
        ) : (
          <p className="app-card-desc">
            Uploads are not available just now. Try again in a minute.
          </p>
        )}
      </Card>
    </AppPage>
  );
}
