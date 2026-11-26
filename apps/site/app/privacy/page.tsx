import { LEGAL_NAME, SUPPORT_EMAIL } from '@cuttingfloor/plans';
import type { Metadata } from 'next';
import { Items, LegalPage, P, Part } from '../legal.tsx';

export const metadata: Metadata = {
  title: 'Privacy — cuttingfloor',
  description:
    'What personal data cuttingfloor collects, why, who receives it, how long it is kept and your choices. Footage is deleted after 7 days and never used to train models.',
  alternates: { canonical: '/privacy', types: { 'text/markdown': '/privacy.md' } },
};

const mail = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;

// Laid out by what app directories check a policy for: the categories of personal data, the
// purposes, the categories of recipients, retention, and the user's controls.
export default function Privacy() {
  return (
    <LegalPage
      label="Privacy"
      href="/privacy"
      effective="November 15, 2026"
      title="Privacy policy."
      lede={`What personal data cuttingfloor collects, why, who receives it, how long we keep it, and your choices. cuttingfloor is run by ${LEGAL_NAME}.`}
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
      <Part title="Categories of personal data we collect">
        <Items
          items={[
            'Account data: your email, name and how you sign in, and the account id your app signs in with.',
            'Billing data: your payment history (held by Stripe; we never see your card number) and your credits: the free ones, the packs you bought and the watermarks you removed with them.',
            'Your content: the files you upload or import, the exports and timelines you make, and what your agent sends each tool: its instructions for that step and any file you attach. We never see your chat.',
            'Data worked out from your content: transcripts, beats, scenes, where faces and speakers are, and a search index of each video’s and picture’s frames (small pictures and number summaries of what they show). Faces and voices are used only to make the edit you asked for, never to identify anyone.',
            'What you or your agent tell us: the task you said you wanted to make when your account started, and messages your agent sends the cuttingfloor team (what went wrong, and what would have helped).',
            'Usage data: a record of each tool call (which tool, when, how long it took, and an error’s code and message, never its arguments or result), job records (which job ran, for how long), downloads (which export, the day, whether from its page or its link, and the app), which app you first connected from, which link or ad first brought you (when it was tagged) and when you first edited and exported, and sign-in steps (the time and the app’s name when an app asks how to sign in, without its address).',
            'Technical data: server logs of the IP address a request came from, its time and what it asked for; on the website, visits, pages and the links and buttons clicked, and cookies: one that keeps you signed in and, for 30 days after a tagged link or ad, one that remembers which it was.',
            'Keys you save: a provider key (your sync. labs key), kept encrypted, and keys you make for scripts.',
          ]}
        />
      </Part>
      <Part title="Purposes: why we use it">
        <Items
          items={[
            'To run the editor: import, analyse, search, edit, render and export your media as your agent asks.',
            'To run your account: sign you in, keep your credits and bill you.',
            'To start you off with a sample that fits what you want to make, and to fix and improve cuttingfloor from what you and your agent tell us.',
            'To send account email: welcome, credits running low, payment problems, and a reminder before your files are deleted.',
            'To keep the service working and safe, and to see which apps people use where they stop while connecting, and which links and ads bring people who sign up.',
          ]}
        />
        <P>We don&apos;t use your data to train models, sell it, or use it for advertising.</P>
      </Part>
      <Part title="Categories of recipients">
        <P>Each one gets only what its job needs:</P>
        <Items
          items={[
            'The app you connected (ChatGPT, Claude, Kazi or another) gets tool results, under its own privacy policy: the names, sizes and details of your media, transcripts and measurements of it, timelines, previews, download links that expire, and the ids that tie one step to the next. Never your email, payment details or keys.',
            'Hosting: Hetzner runs the editor and holds your media, in Ashburn, Virginia (USA); transcripts, voiceovers, cutouts and the search index are made there too. Vercel runs this website and its analytics.',
            'Accounts and payments: WorkOS (sign-in and accounts), Stripe (payments and invoices), Kazi (the credit ledger, which keeps your balance by your email and account, so credits work on both).',
            'Email: Resend sends account email.',
            'Judgment model: TypeSafe gets the frames and text your agent asks a question about (judge.ask, media.seek, media.search, or a look through a video), only to answer it.',
            'Lip sync, only with your own key: sync. labs gets the stretch of video and the speech your agent names, under your account with them.',
          ]}
        />
      </Part>
      <Part title="Retention: how long we keep it">
        <Items
          items={[
            'Uploads, imported media, exports and what is worked out from them (transcripts, the search index): 7 days after they are made, or after last use for media.',
            'Timelines (the edits themselves): 7 days after they were last used.',
            'Account data and account records: for as long as you have an account.',
            'Billing records: as long as the law asks.',
            'Job records and sign-in steps: 13 months.',
            'Tool call records: 30 days.',
            'The task you started with, and messages to the team: for as long as you have an account.',
            'Server logs: a few weeks.',
            'Keys you make for scripts: as long as they last. A saved provider key: until you remove it.',
          ]}
        />
      </Part>
      <Part title="Your choices and rights">
        <Items
          items={[
            <>
              Ask for a copy of what we hold about you, ask us to correct it, or close your account
              and have it deleted: write to {mail}.
            </>,
            'Delete any media sooner: ask your agent to delete it; otherwise it deletes itself on the schedule above.',
            'Turn the reminder email before files are deleted on or off on your account page.',
            'Remove a saved provider key or a script key on your account page.',
            'Sign out to remove the sign-in cookie.',
          ]}
        />
      </Part>
      <Part title="Contact and changes">
        <P>
          Questions about this policy or your data: {mail}. If we change this policy in a way that
          matters, we email you first.
        </P>
      </Part>
    </LegalPage>
  );
}
