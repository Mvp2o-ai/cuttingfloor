import { withAuth } from '@workos-inc/authkit-nextjs';
import { AccountNav } from '../../account/chrome.tsx';
import { FILE_ID, releaseOf } from '../../lib/release.ts';
import { credits } from '../../pricing.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Release a clean copy — cuttingfloor', robots: { index: false } };

// What the QR code on a review copy's cards opens. Anyone can see the video, so the page asks the
// viewer to sign in and finds the file only on their own account: a stranger who scans it can
// neither spend the owner's credits nor take the clean copy. The owner sees the price and their
// credits, removes the watermark here, and the clean copy plays with its download beside it.
export default async function ReleasePage({
  params,
  searchParams,
}: {
  params: Promise<{ file: string }>;
  searchParams: Promise<{ released?: string; short?: string; failed?: string }>;
}) {
  const { user } = await withAuth({ ensureSignedIn: true });
  const { file } = await params;
  const { released, short, failed } = await searchParams;
  const found = FILE_ID.test(file) ? await releaseOf(user.id, file) : undefined;
  const r = found?.ok ? found.release : undefined;

  let body: React.ReactNode;
  if (!r) {
    const away = found && !found.ok && found.status !== 404;
    body = (
      <>
        <h1 className="display acct-head">
          {away ? 'We can’t reach this video just now.' : 'This video isn’t on this account.'}
        </h1>
        <p className="lede">
          {away
            ? 'Try again in a moment.'
            : `You’re signed in as ${user.email}. Sign in with the account that made the video. Videos are kept 7 days after they were last used, so it may also have gone; ask your assistant to export it again.`}
        </p>
      </>
    );
  } else if (!r.watermarked) {
    body = (
      <>
        <h1 className="display acct-head">Your clean copy is ready.</h1>
        <p className="lede">
          {r.name}
          {released && r.spent ? ` · ${credits(r.spent)} credits used` : ''}. Every link to it is
          now clean.
        </p>
        {/\.(?:png|jpe?g|webp|gif)$/i.test(r.name) ? (
          <img className="release-view" src={r.url} alt={r.name} />
        ) : (
          // Muted so phones let it start on its own; its controls turn the sound on.
          <video className="release-view" src={r.url} autoPlay muted playsInline controls />
        )}
        <div className="actions">
          <a className="buy" href={r.url} download={r.name}>
            Download
          </a>
          <a className="buy quiet" href={r.page_url}>
            Watch it
          </a>
        </div>
      </>
    );
  } else {
    const price = r.release_credits ?? 0;
    const enough = r.credits_left === null || r.credits_left >= price;
    body = (
      <>
        <h1 className="display acct-head">Release a clean copy.</h1>
        <p className="lede">
          {r.name}: {credits(price)} credit{price === 1 ? '' : 's'} to remove the watermark, once.
          {r.credits_left === null ? '' : ` You have ${credits(r.credits_left)}.`}
        </p>
        {short || failed ? (
          <p className="acct-banner" role="status">
            {short
              ? 'Not enough credits yet: nothing was spent.'
              : 'The watermark could not be removed just now: nothing was spent. Try again.'}
          </p>
        ) : null}
        <div className="actions">
          {enough ? (
            <form action="/api/release" method="post">
              <input type="hidden" name="file" value={r.file} />
              <button type="submit" className="buy" data-track="Release: QR page">
                Remove the watermark
              </button>
            </form>
          ) : (
            <a className="buy" href="/account#buy">
              Get credits
            </a>
          )}
          <a className="buy quiet" href={r.page_url}>
            Watch the review copy
          </a>
        </div>
      </>
    );
  }

  return (
    <>
      <AccountNav email={user.email} />
      <main className="frame acct">
        <section className="cell marks acct-top">
          <span className="mark-b" />
          <span className="label">Your video</span>
          {body}
        </section>
      </main>
    </>
  );
}
