import * as z from 'zod/v4';

// account.get: the signed-in account's plan, credits and top-up, a fact the agent cannot get
// itself, so it can say whether removing a watermark fits before doing it.

export const AccountGetInput = z.object({});

const nullableCount = z.number().nullable();

export const AccountGetResult = z.object({
  plan: z
    .enum(['local', 'free', 'credits', 'enterprise', 'lifetime', 'staff'])
    .describe(
      'local: a server you run yourself, with no credits and no mark. free: the free credits, not topped up yet. credits: pay as you go, has bought credits. enterprise, lifetime, staff: given plans, whose files never have the watermark',
    ),
  plan_name: z.string(),
  credits: z.object({
    left: nullableCount.describe(
      'Credits left; null when there is no cap. Credits remove watermarks (export.release, priced by finished length); making is free, so at 0 everything still works and files keep the mark',
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

// credits.claim: activates the account (once, with the use case in the user's words), adds the
// onboarding sample to the library and returns the balance. Its starting credits are granted when
// its credit ledger account opens (its first signed-in call); the claim itself grants and spends
// nothing.

export const ClaimFreeCreditsInput = z.object({
  use_case: z
    .string()
    .max(280)
    .describe(
      'What task the user is looking to complete with cuttingfloor, in their words where possible',
    ),
});
export type ClaimFreeCreditsInput = z.infer<typeof ClaimFreeCreditsInput>;

export const ClaimFreeCreditsResult = z.object({
  claimed_now: z
    .boolean()
    .describe('true on the call that activated the account; false when it was already active'),
  message: z.string(),
  credits: AccountGetResult.shape.credits
    .nullable()
    .describe("The account's credits, as account.get gives them; null when they can't be read"),
  media_id: z
    .string()
    .nullable()
    .describe(
      "Big Buck Bunny, a 30-second sample (Blender Foundation, CC BY) added to the user's library, free, to try edits on; null when it couldn't be added",
    ),
  job_id: z.string().optional().describe("The sample's import, while it runs"),
  status: z.string().optional().describe("The sample import's status, while it runs"),
});
export type ClaimFreeCreditsResult = z.infer<typeof ClaimFreeCreditsResult>;
