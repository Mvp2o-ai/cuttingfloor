import { FREE_CREDITS, SUPPORT_EMAIL } from '@cuttingfloor/plans';
import type { Metadata } from 'next';
import { Items, LegalPage, P, Part } from '../legal.tsx';

export const metadata: Metadata = {
  title: 'Refunds — cuttingfloor',
  description:
    'When cuttingfloor refunds a payment: unused credits from a pack bought in the last 14 days, and billing mistakes always.',
  alternates: { canonical: '/refunds', types: { 'text/markdown': '/refunds.md' } },
};

const mail = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;

export default function Refunds() {
  return (
    <LegalPage
      label="Refunds"
      href="/refunds"
      title="Refunds."
      lede={`Try it free first with ${FREE_CREDITS} credits, no card. If you pay and it isn't working out, here's what we refund.`}
    >
      <Part title="Credit packs">
        <P>
          Within 14 days of buying a pack, you can ask for a refund of the credits you haven't used.
          Credits you have used aren't refunded. A refunded pack's credits come off your balance.
        </P>
      </Part>
      <Part title="Automatic top-up">
        <P>
          Automatic top-up is off unless you turn it on, and you can turn it off any time on your
          account page. A top-up you didn't want is a pack like any other: ask within 14 days and we
          refund the credits you haven't used.
        </P>
      </Part>
      <Part title="Mistakes">
        <Items
          items={[
            'Charged twice, or topped up after you turned automatic top-up off: we refund it in full.',
            'A long outage on our side: write to us and we make it right.',
          ]}
        />
      </Part>
      <Part title="How to ask">
        <P>
          Write to {mail} from the email on your account. Refunds go back to the card you paid with,
          usually within 5 to 10 days.
        </P>
      </Part>
    </LegalPage>
  );
}
