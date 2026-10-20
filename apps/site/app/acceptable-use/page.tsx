import { SUPPORT_EMAIL } from '@cuttingfloor/plans';
import type { Metadata } from 'next';
import { Items, LegalPage, P, Part } from '../legal.tsx';

export const metadata: Metadata = {
  title: 'Acceptable use — cuttingfloor',
  description:
    'What you and your agent may not do with cuttingfloor: illegal or abusive content, other people’s footage without rights, and attacks on the service.',
  alternates: { canonical: '/acceptable-use' },
};

const mail = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;

export default function AcceptableUse() {
  return (
    <LegalPage
      label="Acceptable use"
      href="/acceptable-use"
      title="Acceptable use."
      lede="Make whatever you like, within a few lines. These apply to you and to anything your agent does on your account."
    >
      <Part title="Don't make or upload">
        <Items
          items={[
            'Anything sexual involving minors, ever. We report it.',
            'Sexual or intimate content of a real person without their consent, including faked footage.',
            'Footage that makes a real person seem to say or do something they didn’t, made to deceive or harm them.',
            'Content that threatens, harasses or incites violence against people.',
            'Footage, music or other work you don’t have the rights to use.',
            'Anything else that is illegal where you or we are.',
          ]}
        />
      </Part>
      <Part title="Don't misuse the service">
        <Items
          items={[
            'Break into, probe or overload our servers, or try to get around plan limits.',
            'Use the code sandbox to mine, scan networks, send spam or attack anyone.',
            'Share an account, or open accounts to chain free trials.',
            'Resell the hosted service without an agreement with us.',
          ]}
        />
      </Part>
      <Part title="What happens">
        <P>
          We may remove content, pause an account or close it if these are broken, and we report
          illegal content where the law requires. To report something, write to {mail}.
        </P>
      </Part>
    </LegalPage>
  );
}
