import { PRICED, SUPPORT_EMAIL } from '@cuttingfloor/plans';
import {
  IMAGE,
  KEYS,
  LICENCE,
  LOCAL_ADDRESS,
  NO_KEY,
  REPO_URL,
  SELF_HOST_STEPS,
} from '../../content/facts.ts';
import { CREDIT, EVERY_PLAN, JUDGMENT_TOOLS, KEPT_DAYS, TIMELINE_HOURS } from '../pricing.ts';
import { SITE_URL } from '../seo.ts';

// /pricing as data, for agents: the plans file's numbers with their units, self-hosting and keys.
// Bump the schema's version when a field changes meaning or goes away.
export const dynamic = 'force-static';

export function GET() {
  const body = {
    schema: 'cuttingfloor.pricing/2',
    url: `${SITE_URL}/pricing`,
    markdown: `${SITE_URL}/pricing.md`,
    currency: 'USD',
    units: {
      price_month: 'US dollars a month',
      price_year: 'US dollars a year (ten months)',
      credits:
        'one credit is one minute of a job running (export, import, transcript, graphics, voiceover, cutout), per period',
      period: 'once (free credits, no time limit), or a month',
      jobs: 'jobs that run at once; more wait their turn',
      short_side_px: 'largest export, as its short side in pixels (1080 is 1080p, 2160 is 4K)',
      storage_gb: 'gigabytes held on the server at once',
      judgments_per_day: `visual judgments a day (${JUDGMENT_TOOLS.join(', ')})`,
      null: 'no limit',
    },
    credit: CREDIT,
    every_plan: EVERY_PLAN,
    overage: 'none: at the limit new jobs wait; editing and previews keep working',
    self_hosted: {
      price_month: 0,
      licence: LICENCE,
      image: IMAGE,
      same_image_as_hosted: true,
      credits: null,
      repository: REPO_URL,
      steps: SELF_HOST_STEPS,
      address: LOCAL_ADDRESS,
      docs: `${SITE_URL}/self-host`,
    },
    plans: PRICED.map((p) => ({
      id: p.id,
      name: p.name,
      price_month: p.id === 'free' ? 0 : (p.price?.month ?? null),
      price_year: p.price?.year ?? null,
      sold: p.sold === 'contact' ? `contact ${SUPPORT_EMAIL}` : 'self-serve',
      ...(p.id === 'free' ? { card_required: false, expires: false } : {}),
      period: p.id === 'free' ? 'once' : 'month',
      // Enterprise limits are agreed on a call, so it publishes none.
      ...(p.sold === 'contact'
        ? { limits: 'agreed with us' }
        : {
            credits: p.limits.renderMinutes,
            jobs: p.limits.jobs,
            short_side_px: p.limits.shortSide,
            storage_gb: p.limits.storageGb,
            judgments_per_day: p.limits.judgmentsPerDay,
          }),
      note: p.note,
    })),
    keys: KEYS.map((k) => ({
      feature: k.feature,
      tools: k.tools,
      hosted: k.hosted,
      self_hosted: k.selfHosted,
    })),
    no_key: NO_KEY,
    kept_hosted: {
      media_and_exports_days: KEPT_DAYS,
      timelines_hours_after_last_use: TIMELINE_HOURS,
    },
  };
  return Response.json(body);
}
