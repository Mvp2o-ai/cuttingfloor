import {
  CLEAN_COPY_STEP,
  FREE_CREDITS,
  LOW_CREDITS,
  PACKS,
  PLANS,
  type PlanId,
  SUPPORT_EMAIL,
} from '@cuttingfloor/plans';
import {
  IMAGE,
  KEYS,
  LICENCE,
  LOCAL_ADDRESS,
  NO_KEY,
  REPO_URL,
  SELF_HOST_STEPS,
} from '../../content/facts.ts';
import { CREDIT, EVERY_PLAN, KEPT_DAYS, TIMELINE_HOURS } from '../pricing.ts';
import { SITE_URL } from '../seo.ts';

// /pricing as data, for agents: the plans file's numbers with their units, self-hosting and keys.
// Bump the schema's version when a field changes meaning or goes away.
export const dynamic = 'force-static';

export function GET() {
  const body = {
    schema: 'cuttingfloor.pricing/4',
    url: `${SITE_URL}/pricing`,
    markdown: `${SITE_URL}/pricing.md`,
    currency: 'USD',
    units: {
      price: 'US dollars, paid once for a pack; nothing renews',
      credits:
        'one credit removes the watermark from one finished minute of an exported video, GIF or image, counted in quarter-minute steps; bought credits never expire',
      short_side_px: 'largest export, as its short side in pixels (1080 is 1080p, 2160 is 4K)',
      storage_gb: 'gigabytes held on the server at once',
      null: 'no limit',
    },
    credit: CREDIT,
    every_plan: EVERY_PLAN,
    model:
      'making is free; exports download free with a cuttingfloor watermark; removing the watermark is paid in credits, once per export; credit packs, no subscription',
    making:
      'free: imports, edits, analysis, exports, motion graphics and voiceovers spend no credits',
    marked: {
      what: 'exported video, GIF and image downloads, and generated clips, at full quality',
      never: [
        'audio (WAV, MP3, voiceovers)',
        'captions and transcripts',
        'project files (SRT, VTT, FCPXML, OTIO, EDL)',
        'your own uploads and imports',
      ],
    },
    clean_copy: {
      credits_per_finished_minute: 1,
      step_minutes: CLEAN_COPY_STEP,
      minimum_credits: CLEAN_COPY_STEP,
      image_credits: CLEAN_COPY_STEP,
      same_price_4k: true,
      paid: 'once per export; every later download of it is clean',
    },
    free_credits: FREE_CREDITS,
    free_credits_when: 'granted when a new account is activated',
    packs: PACKS.map((p) => ({ id: p.id, price: p.price, credits: p.credits })),
    automatic_top_up: `optional: a chosen pack is bought on the saved card when fewer than ${LOW_CREDITS} credits are left`,
    low_credit_email_below: LOW_CREDITS,
    overage:
      'none: at zero, making, previews and watermarked downloads keep working; removing watermarks waits for credits',
    self_hosted: {
      price: 0,
      licence: LICENCE,
      image: IMAGE,
      same_image_as_hosted: true,
      credits: null,
      marked: false,
      repository: REPO_URL,
      steps: SELF_HOST_STEPS,
      address: LOCAL_ADDRESS,
      docs: `${SITE_URL}/self-host`,
    },
    plans: (['free', 'credits', 'enterprise'] as PlanId[])
      .map((id) => PLANS[id])
      .map((p) => ({
        id: p.id,
        name: p.name,
        sold:
          p.sold === 'contact'
            ? `contact ${SUPPORT_EMAIL}`
            : p.id === 'free'
              ? 'every new account'
              : 'credit packs, self-serve',
        ...(p.id === 'free'
          ? {
              credits: FREE_CREDITS,
              granted: 'at activation',
              card_required: false,
              expires: false,
            }
          : {}),
        ...(p.id === 'credits' ? { credits: 'as bought', expires: false } : {}),
        // Enterprise limits are agreed on a call, so it publishes none.
        ...(p.sold === 'contact'
          ? { limits: 'agreed with us' }
          : {
              short_side_px: p.limits.shortSide,
              storage_gb: p.limits.storageGb,
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
