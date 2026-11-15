import { withAuth } from '@workos-inc/authkit-nextjs';
import { AccountNav } from '../account/chrome.tsx';
import { FilesPanel } from '../account/files.tsx';
import { filesOf } from '../lib/files.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Upload — cuttingfloor', robots: { index: false } };

// Where a user drops files for their AI to use: the files and nothing else, so tools and
// instructions can link here (the account page also sells credits).
export default async function UploadPage() {
  const { user } = await withAuth({ ensureSignedIn: true });
  const files = await filesOf(user.id);
  return (
    <>
      <AccountNav email={user.email} />
      <main className="frame acct">
        <section className="cell" id="files">
          <div className="head">
            <span className="label">Your files</span>
            <p className="lede">
              Your footage, music, logos and photos: drop them here and your AI can use them. Tell
              it the file’s name, for example “cut the pauses out of interview.mp4”.
            </p>
          </div>
          {files ? (
            <FilesPanel initial={files} />
          ) : (
            <p className="lede">Uploads are not available just now. Try again in a minute.</p>
          )}
        </section>
      </main>
    </>
  );
}
