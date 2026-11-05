import { LEGAL_NAME, SUPPORT_EMAIL } from '@cuttingfloor/plans';
import type { Metadata } from 'next';
import { Items, LegalPage, P, Part } from '../legal.tsx';

export const metadata: Metadata = {
  title: 'Support — cuttingfloor',
  description:
    'Get help with cuttingfloor: write to support, what to include, and where to check the service status.',
  alternates: { canonical: '/support', types: { 'text/markdown': '/support.md' } },
};

const mail = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;

export default function Support() {
  return (
    <LegalPage
      label="Support"
      href="/support"
      title="Support."
      lede={`Help with cuttingfloor, from the people who make it at ${LEGAL_NAME}.`}
    >
      <Part title="Write to us">
        <P>Email {mail}. A person answers, usually within one working day.</P>
      </Part>
      <Part title="What helps us help you">
        <Items
          items={[
            'The email you signed in with.',
            'The app you use cuttingfloor from (ChatGPT, Claude, Kazi or another).',
            'What you asked for, and what happened instead. A job id or media id from the reply helps.',
            'A link to the export, if it is about a video.',
          ]}
        />
      </Part>
      <Part title="Before you write">
        <Items
          items={[
            'Is it down? See the status page, cuttingfloor.ai/status.',
            'Connecting an app: the steps for each one are at cuttingfloor.ai/connect.',
            'Plans and billing: your account page, cuttingfloor.ai/account.',
          ]}
        />
      </Part>
      <Part title="Your data">
        <P>
          To get a copy of your data, or to close your account and delete it, write to {mail}. The
          privacy policy (cuttingfloor.ai/privacy) says what we keep and for how long.
        </P>
      </Part>
    </LegalPage>
  );
}
