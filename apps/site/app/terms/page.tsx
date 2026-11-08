import { FREE_CREDITS, LEGAL_NAME, PLANS, SUPPORT_EMAIL } from '@cuttingfloor/plans';
import type { Metadata } from 'next';
import { Items, LegalPage, P, Part } from '../legal.tsx';

export const metadata: Metadata = {
  title: 'Terms — cuttingfloor',
  description:
    'The terms for using cuttingfloor, the hosted video editing server for AI agents: free credits, credit packs, automatic top-up, your content and ours.',
  alternates: { canonical: '/terms', types: { 'text/markdown': '/terms.md' } },
};

const mail = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;

export default function Terms() {
  return (
    <LegalPage
      label="Terms"
      href="/terms"
      title="Terms of service."
      lede={`These are the rules for using cuttingfloor. cuttingfloor is run by ${LEGAL_NAME} ("we"). By signing up or connecting your agent, you agree to them.`}
    >
      <Part title="What cuttingfloor is">
        <P>
          cuttingfloor is a video editing server for AI agents. You connect your agent (Claude,
          Cursor, ChatGPT, Kazi or any MCP client) to api.cuttingfloor.ai, and it uses our tools to
          import, cut, caption, mix and export video. We run the servers; your agent decides the
          edit.
        </P>
        <P>
          The same software is also on GitHub for running on your own machine. That copy comes under
          the licence published in its repository, not these terms, and you run it yourself.
        </P>
      </Part>
      <Part title="Your account">
        <P>
          You need an account with a verified email to use the hosted server. Keep your sign-in to
          yourself; you're responsible for what's done with your account, including what your agent
          does with it. You must be at least 16, or old enough to agree to these terms where you
          live.
        </P>
      </Part>
      <Part title="Free credits and credit packs">
        <Items
          items={[
            `Every new account gets ${FREE_CREDITS} free credits, with no card. They don't expire and don't renew.`,
            'After that, you buy credits in packs, paid once through Stripe. There is no subscription and nothing renews. The prices are on the pricing page.',
            'A credit is one minute of a job running on our servers (an export, an import, a transcript, motion graphics, a voiceover, a cutout). Editing the timeline and previews are free.',
            'Credits you buy never expire. When your credits run out, new jobs stop until you buy more. We never charge for going over.',
            'If you turn on automatic top-up, we buy the pack you chose on your saved card whenever your credits run low, and email you a receipt each time. Turn it off any time on your account page.',
            `${PLANS.enterprise.name} is arranged with us directly: write to ${SUPPORT_EMAIL}.`,
            'We may change pack prices. A change applies to packs bought after it; credits you already have keep working.',
          ]}
        />
      </Part>
      <Part title="Payments">
        <P>
          Stripe takes the payments; we never see your card number. Your card is saved with Stripe
          when you first buy, so later packs take one click; you can change or remove it from your
          account page.
        </P>
        <P>
          If an automatic top-up fails, we email you and nothing else is charged; buy a pack on your
          account page to carry on. Refunds are covered on the <a href="/refunds">refunds page</a>.
        </P>
      </Part>
      <Part title="Your content">
        <P>
          The footage, audio, images and text you or your agent send us stay yours. You give us
          permission to store and process them only to do what your agent asks: to edit, render,
          transcribe, judge and export them. We don't use them to train models, and we don't share
          them except as the <a href="/privacy">privacy policy</a> says.
        </P>
        <P>
          You must have the rights to what you upload. Uploads, media and exports are deleted 7 days
          after they are made, and timelines 24 hours after they were last used. Keep your own
          copies; cuttingfloor is not a place to store files.
        </P>
      </Part>
      <Part title="Using it fairly">
        <P>
          Follow the <a href="/acceptable-use">acceptable use policy</a>. We may pause or close an
          account that breaks it, puts the service or other people at risk, or doesn't pay. If we
          close an account for anything other than a serious breach, we refund the unused part of a
          paid period.
        </P>
      </Part>
      <Part title="Our part">
        <P>
          The software, the site and the cuttingfloor name are ours. We work to keep the service
          running and fast, but we can't promise it never goes down or never makes a mistake: an
          agent can make edits you didn't want, and renders can fail. Check what you publish. The
          service is provided as it is, without warranties beyond those the law requires.
        </P>
        <P>
          As far as the law allows, we aren't liable for indirect or lost-profit damages, and our
          total liability for any claim is limited to what you paid us in the 12 months before it.
          Nothing here limits liability that can't be limited by law.
        </P>
      </Part>
      <Part title="Changes and the law">
        <P>
          We may update these terms. If a change matters, we email you before it takes effect; using
          cuttingfloor after that means you accept it. These terms are governed by the laws of the
          place {LEGAL_NAME} is established.
        </P>
      </Part>
      <Part title="Questions">
        <P>Write to {mail}.</P>
      </Part>
    </LegalPage>
  );
}
