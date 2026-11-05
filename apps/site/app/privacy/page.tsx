import { LEGAL_NAME, SUPPORT_EMAIL } from '@cuttingfloor/plans';
import type { Metadata } from 'next';
import { Items, LegalPage, P, Part } from '../legal.tsx';

export const metadata: Metadata = {
  title: 'Privacy — cuttingfloor',
  description:
    'What cuttingfloor keeps about you and your footage, how long, and who helps us run it. Footage is deleted after 7 days and never used to train models.',
  alternates: { canonical: '/privacy', types: { 'text/markdown': '/privacy.md' } },
};

const mail = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;

export default function Privacy() {
  return (
    <LegalPage
      label="Privacy"
      href="/privacy"
      title="Privacy policy."
      lede={`What we keep about you and your footage, for how long, and who helps us run cuttingfloor. cuttingfloor is run by ${LEGAL_NAME}.`}
    >
      <Part title="The short version">
        <Items
          items={[
            'Your footage is used only to do what your agent asks, and is deleted after 7 days.',
            "We don't train models on it, sell it, or show it to anyone.",
            'We keep only what an account and its billing need.',
          ]}
        />
      </Part>
      <Part title="What we keep, and for how long">
        <Items
          items={[
            'Your account: email, name and how you sign in. WorkOS holds it for us, for as long as you have an account.',
            'Billing: your plan and payment history. Stripe holds it; we never see your card number.',
            'Uploads, imported media and exports: 7 days after they are made.',
            'Timelines (the edits themselves): 24 hours after they were last used.',
            'Render-minute records (which job ran, for how long): 13 months, to count your plan and for billing questions.',
            'Account records: which app you first connected from and when you first edited and exported, kept with your account, to see which apps people use and to send the right account emails.',
            'Keys you save: a provider key (your sync. labs key) is kept encrypted in your account, and only its last four characters are ever shown. Keys you make for scripts are kept as long as they last.',
            'Sign-in steps: when an app asks this server how to sign in, we note the time and the app’s name (no address): 13 months, to see where people stop while connecting.',
            'Server logs: the address a request came from, its time and what it asked for, kept a few weeks to keep the service running and safe.',
            'What we work out from your media (transcripts, beats, scenes, where faces and speakers are): kept with the media for 7 days. Faces and voices are used only to make the edit you asked for, never to identify anyone.',
            'Sign-in: the account id your app signs in with. We check each sign-in token and don’t keep it.',
          ]}
        />
      </Part>
      <Part title="What your agent sends and gets back">
        <P>
          From the app you connected we get only what your agent sends each tool: its instructions
          for that step and any file you attach to it. We never see your chat.
        </P>
        <P>
          Tool results go to the app you connected (ChatGPT, Claude, Kazi or another), which handles
          them under its own privacy policy. They hold what your agent asked for: the names, sizes
          and details of your media, transcripts and measurements of it, timelines, previews,
          download links that expire, and job and media ids that tie one step to the next. They
          never hold your email, payment details or keys.
        </P>
      </Part>
      <Part title="How your footage is used">
        <P>
          Your footage is processed on our own servers at Hetzner, in Ashburn, Virginia (USA), to
          edit, render and export it. Transcripts, voiceovers and cutouts run on those servers too.
        </P>
        <P>
          When your agent asks a question about a picture or a passage (judge.ask, or a look through
          a video with media.analyze), the frames and text it names are sent to TypeSafe, the model
          provider that answers. They're used only to answer that question.
        </P>
        <P>
          When your agent lip-syncs a clip (create.lipsync) with your own sync. labs key, the
          stretch of video and the speech it names are sent to sync. labs to make the new clip,
          under your account with them. We don't keep your key.
        </P>
      </Part>
      <Part title="Who helps us run it">
        <Items
          items={[
            'WorkOS: sign-in and accounts.',
            'Stripe: payments and invoices.',
            'Hetzner: the servers that run the editor and hold your media.',
            'Vercel: this website.',
            'TypeSafe: answers to judge.ask and look questions.',
            'sync. labs, only with your own key: lip sync for create.lipsync.',
            'Resend: account email (trial ending, usage, payment problems).',
          ]}
        />
        <P>Each one gets only what its job needs.</P>
      </Part>
      <Part title="The website">
        <P>
          The site uses Vercel Analytics to count visits, pages, sign-ups and which links and
          buttons are clicked, without ad trackers or cross-site cookies. Signing in sets a cookie
          that keeps you signed in.
        </P>
      </Part>
      <Part title="Your choices">
        <P>
          You can ask for a copy of what we hold about you, ask us to correct it, or close your
          account and have it deleted: write to {mail}. Media and timelines delete themselves on the
          schedule above; we keep billing records as long as the law asks.
        </P>
      </Part>
      <Part title="Changes">
        <P>
          If we change this policy in a way that matters, we email you first. Questions: {mail}.
        </P>
      </Part>
    </LegalPage>
  );
}
