import { SUPPORT_EMAIL, TRIAL_DAYS } from '@cuttingfloor/plans';
import type { Metadata } from 'next';
import { Items, LegalPage, P, Part } from '../legal.tsx';

export const metadata: Metadata = {
  title: 'Refunds — cuttingfloor',
  description:
    'When cuttingfloor refunds a payment: yearly plans within 14 days, billing mistakes always. Cancel any time from your account.',
  alternates: { canonical: '/refunds' },
};

const mail = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;

export default function Refunds() {
  return (
    <LegalPage
      label="Refunds"
      href="/refunds"
      title="Refunds."
      lede={`Try it free for ${TRIAL_DAYS} days first, no card. If you pay and it isn't working out, here's what we refund.`}
    >
      <Part title="Yearly plans">
        <P>
          Within 14 days of buying or renewing a yearly plan, you can ask for a refund of the unused
          part: the months you haven't started yet.
        </P>
      </Part>
      <Part title="Monthly plans">
        <P>
          Monthly payments aren't refunded. Cancel any time from your account page and the plan
          stops at the end of the month you paid for.
        </P>
      </Part>
      <Part title="Mistakes">
        <Items
          items={[
            'Charged twice, or charged after you cancelled: we refund it in full.',
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
