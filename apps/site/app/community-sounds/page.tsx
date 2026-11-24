import type { Metadata } from 'next';
import { communityPage, soundsBase } from '../lib/sounds.ts';
import { Footer, Nav } from '../shell.tsx';
import { CommunitySounds } from './community-sounds.tsx';

// /community-sounds: sounds creators shared (the community pack of the sound library). Anyone plays
// and searches them; a signed-in user shares a sound of their own and takes theirs down. An agent
// finds the same sounds with sounds.list.

const TITLE = 'Community sounds';
const DESCRIPTION =
  'Free sounds shared by creators for your edits: beats, voice lines, meme sounds and effects. Play them here, share your own, and ask your AI to add one to your video. Nothing to buy.';

// Static, refreshed every minute; whether the visitor is signed in is asked from the browser.
export const revalidate = 60;

export const metadata: Metadata = {
  title: `${TITLE} | cuttingfloor`,
  description: DESCRIPTION,
  alternates: { canonical: '/community-sounds' },
  openGraph: { type: 'website', url: '/community-sounds', title: TITLE, description: DESCRIPTION },
};

export default async function CommunitySoundsPage() {
  const first = await communityPage('popular');
  return (
    <>
      <Nav />
      <main className="frame csound">
        <section className="cell">
          <div className="head">
            <span className="label">Community sounds · free</span>
            <h1>Sounds from creators, for your edits.</h1>
            <p className="lede">
              Beats, voice lines, meme sounds and effects other creators shared, free to use. Play
              any of them here, then ask your AI to add it to your video. Have a sound of your own?
              Share it: a small way to give back.
            </p>
          </div>
          <CommunitySounds first={first ?? null} base={soundsBase()} />
        </section>
      </main>
      <Footer />
    </>
  );
}
