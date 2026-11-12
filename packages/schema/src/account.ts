import * as z from 'zod/v4';

// account.get: the signed-in account's plan, credits and top-up, a fact the agent cannot get
// itself, so it can say what a job will leave before starting it.

export const AccountGetInput = z.object({});

const nullableCount = z.number().nullable();

export const AccountGetResult = z.object({
  plan: z
    .enum(['local', 'free', 'credits', 'enterprise', 'lifetime', 'staff'])
    .describe(
      'local: a server you run yourself, with no credits. free: the free credits, not topped up yet. credits: pay as you go, has bought credits. enterprise, lifetime, staff: given plans whose credits renew monthly or have no cap',
    ),
  plan_name: z.string(),
  credits: z.object({
    left: nullableCount.describe(
      'Credits left; null when there is no cap. At 0, new jobs are refused; editing and previews keep working',
    ),
    used: z
      .number()
      .describe(
        'Credits used: since the account began (pay as you go) or this month (a given plan)',
      ),
    free: z.number().describe('Free credits the account started with'),
    bought: z.number().describe('Credits bought in packs, after refunds. They never expire'),
    per_month: nullableCount.describe("A given plan's credits each month; null otherwise"),
    renews: z
      .string()
      .nullable()
      .describe("When a given plan's credits renew (ISO time); null otherwise"),
  }),
  warnings: z
    .array(
      z.object({
        at_credits: z.number().describe('The email goes out when credits left fall to this'),
        kind: z.enum(['low', 'out']),
        emailed: z
          .boolean()
          .describe('Whether it has gone out for the credits the account has now'),
      }),
    )
    .describe('The emails the account gets as its credits run down'),
  top_up: z
    .object({
      automatic: z
        .boolean()
        .describe('Whether a pack is bought on its own when credits left fall below `below`'),
      pack: z
        .object({ price_usd: z.number(), credits: z.number() })
        .nullable()
        .describe('The pack an automatic top-up buys'),
      below: z.number(),
      card_saved: z
        .boolean()
        .describe('Whether a card is saved, so a top-up on the account page is one click'),
    })
    .nullable()
    .describe('null on a plan that is not bought'),
  packs: z
    .array(z.object({ price_usd: z.number(), credits: z.number() }))
    .describe('Credit packs on sale, smallest first; empty when credits are not bought'),
  limits: z.object({
    export_short_side: nullableCount.describe(
      'Largest export, its short side in pixels; null for any',
    ),
    judgments_per_day: nullableCount,
    storage_gb: nullableCount,
  }),
  account_url: z
    .url()
    .nullable()
    .describe(
      'The account page, where the user signs in to see their credits and top up; null locally',
    ),
});
export type AccountGetResult = z.infer<typeof AccountGetResult>;
