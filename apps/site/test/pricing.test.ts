import { cleanCopyCredits, FREE_CREDITS } from '@cuttingfloor/plans';
import { describe, expect, it } from 'vitest';
import { GET as llms } from '../app/llms.txt/route.ts';
import { GET as llmsFull } from '../app/llms-full.txt/route.ts';
import { GET as pricingJson } from '../app/pricing.json/route.ts';
import { CREDIT, SHORT_CREDITS } from '../app/pricing.ts';

// The price every page and machine-readable copy states: making is free, exports carry the
// cuttingfloor watermark, credits remove it, priced by length. No copy may keep the old unit or state the rate.

const STALE = [
  /minute of (a|the server|our servers)[^.]* (job|working)/i,
  /minutes of footage/i,
  /judgments for a credit/i,
  /new jobs (won’t|won't|stop|are refused)/i,
  /small mark/i,
  /watermark-free/i,
  /finished minute/i,
];

describe('pricing facts', () => {
  it('prices a watermark-free copy in quarter-minute steps', () => {
    expect(SHORT_CREDITS).toBe('0.75');
    expect(cleanCopyCredits(40)).toBe(0.75);
    // A credit a minute for the first five, half a credit a minute after, in quarter credits.
    expect(cleanCopyCredits(300)).toBe(5);
    expect(cleanCopyCredits(647)).toBe(8);
    expect(cleanCopyCredits(3600)).toBe(32.5);
    expect(cleanCopyCredits(7200)).toBe(62.5);
    expect(CREDIT.join(' ')).toContain('with a cuttingfloor watermark');
  });

  it('publishes the new unit as data', async () => {
    const body = await pricingJson().json();
    expect(body.schema).toBe('cuttingfloor.pricing/5');
    expect(body.free_credits).toBe(FREE_CREDITS);
    expect(body.clean_copy).toMatchObject({ minimum_credits: 0.25 });
    expect(body.clean_copy).not.toHaveProperty('credits_per_finished_minute');
    expect(body.self_hosted).toMatchObject({ credits: null, marked: false });
  });

  it('keeps no stale statement of what a credit is', async () => {
    const texts = [
      await llms().text(),
      await llmsFull().text(),
      JSON.stringify(await pricingJson().json()),
    ];
    for (const text of texts) for (const re of STALE) expect(text).not.toMatch(re);
  });
});
