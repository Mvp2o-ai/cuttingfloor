import * as z from 'zod/v4';

// The admin API (/admin/v1): REST for cuttingfloor's own admins and the systems they connect, such
// as a CRM. Not MCP and not the editing tools. Within v1 changes only add: new fields, endpoints
// and optional parameters. Clients ignore fields they don't know. A breaking change is /admin/v2.

// Times are ISO 8601 in UTC, e.g. 2026-11-20T15:00:00.000Z.
const time = z.string().meta({ format: 'date-time', description: 'ISO 8601 UTC' });
const nullableTime = time.nullable();

export const AdminError = z.object({
  error: z.object({
    code: z
      .string()
      .describe(
        'unauthorized, forbidden, bad_request, not_found, unavailable, or another stable code',
      ),
    message: z.string(),
    hint: z.string().optional().describe('What to do instead'),
  }),
});

export const AdminMe = z.object({
  user: z.string().describe('The WorkOS user id the key belongs to'),
  email: z.string().nullable().describe('null when the account could not be read just now'),
  roles: z.array(z.string()).describe("The user's cuttingfloor roles, e.g. admin"),
  key: z.object({
    key_id: z.string(),
    expires_at: time,
  }),
});

export const AdminFile = z.object({
  kind: z.enum(['media', 'export']).describe('media: imported or uploaded; export: a render'),
  id: z.string().describe('media_id, or the export job_id'),
  name: z.string(),
  expires_at: time.describe(
    'When the file is deleted (ISO 8601 UTC). Using media in an edit pushes it back; an export goes at this time regardless',
  ),
  download_url: z
    .string()
    .nullable()
    .describe(
      'A signed download link for an export, valid for days. Only get_account signs them: null in list pages, and for media',
    ),
  page_url: z
    .string()
    .nullable()
    .describe(
      'The watch page that plays the export in any browser, no sign-in: the link to give the user in an email. While watermarked it shows the price and their credits, and its button removes the watermark; opening the page spends nothing, so a mail scanner checking the link is harmless. Valid as download_url is; null where it is',
    ),
  final_url: z
    .string()
    .nullable()
    .describe(
      'While watermarked, the final copy: opening it spends release_credits once, then downloads the clean file. For a chat or an app the user taps in, not an email (a mail scanner opening it would spend): email page_url instead. Null where download_url is, and when the file is clean',
    ),
  watermarked: z
    .boolean()
    .describe(
      'True: the file downloads with a cuttingfloor watermark until the watermark is removed (export.release). False: it is clean (released, made before 2026-11-23 11:30 UTC, never watermarked, such as audio or an upload, or a given plan)',
    ),
  release_credits: z
    .number()
    .nullable()
    .describe(
      'What removing the watermark costs, in credits, while watermarked; null when it is clean',
    ),
  released_at: nullableTime.describe('When the watermark was removed; null when none was'),
});

export const AdminDownload = z.object({
  file_id: z
    .string()
    .describe(
      "The signed link's id: an export job_id (j_…), kept frames (f_…) or a media_id (m_…)",
    ),
  name: z.string(),
  day: z.string().describe('The UTC day, yyyy-mm-dd'),
  first_at: time,
  last_at: time,
  downloads: z
    .number()
    .describe(
      "Fetches that saved the file (its link, the watch page's Download); a fetch in ranges counts once",
    ),
  plays: z.number().describe('Fetches that played or showed it (a player, an inline fetch)'),
  page_views: z.number().describe('Times its watch page was opened'),
  from_view: z
    .number()
    .optional()
    .describe("Of the saves, those from a chat view's Download button"),
  agent: z
    .string()
    .describe(
      "The client of the day's first request, from its User-Agent (e.g. Mozilla, openai-mcp)",
    ),
});

export const AdminAccount = z.object({
  id: z.string().describe('The WorkOS user id'),
  email: z.string(),
  email_verified: z.boolean(),
  created_at: time,
  made_by: z
    .string()
    .nullable()
    .describe(
      'The partner that made the account for its own user (e.g. the Cutting Floor AI app); null when the person signed up here',
    ),
  referral: z
    .object({
      code: z
        .string()
        .describe(
          "The account's own referral code, made from its id; it never changes and carries nothing personal",
        ),
      link: z.string().describe("The account's link, https://cuttingfloor.ai/r/<code>"),
      referred_by: z
        .string()
        .nullable()
        .describe(
          "The code of the link that brought this account, kept at sign-up (the link's 30-day cookie); null when none did",
        ),
      referred_by_account: z
        .string()
        .nullable()
        .describe('The account that code belongs to; null when none, or no account has it'),
      referred: z
        .object({
          signed_up: z.number().describe("Accounts made through this account's link"),
          used_a_tool: z.number().describe('Of those, accounts that ran a tool (first_tool_at)'),
          exported: z
            .number()
            .describe('Of those, accounts that started an export (first_export_at)'),
        })
        .describe("Who this account's link brought, as of the account list (up to a minute old)"),
    })
    .describe("The account's own link, the link that brought it, and who its link brought"),
  first_call_at: nullableTime.describe('First signed-in request (connecting an app counts)'),
  first_tool_at: nullableTime.describe('First tool call that ran; null means never used'),
  first_edit_at: nullableTime.describe(
    'First video export that finished successfully (the first finished edit); not a timeline change. null: none yet',
  ),
  first_export_at: nullableTime.describe(
    'First video export started, whether or not it succeeded. null: none yet',
  ),
  first_client: z.string().nullable().describe('The app of the first request, e.g. claude'),
  use_case: z
    .string()
    .nullable()
    .describe(
      "The task the user is looking to complete with cuttingfloor, as their assistant gave it when it activated the account (credits.claim); null when it hasn't",
    ),
  use_case_at: nullableTime.describe('When the assistant activated the account'),
  use_cases: z
    .array(z.object({ use_case: z.string(), at: time }))
    .describe(
      "Every task the assistant gave credits.claim, oldest first: the first activated the account, later ones are the user's next projects. Empty before a claim",
    ),
  sample: z
    .string()
    .nullable()
    .describe(
      'The onboarding sample credits.claim put in their library for that task (e.g. gaming-stream, podcast-interview); null before a claim',
    ),
  last_used_at: nullableTime.describe(
    'The day of the latest tool call, recorded at most once a day; null before it was recorded',
  ),
  credits: z
    .object({
      plan: z
        .string()
        .describe(
          'free: only the free credits; credits: pay as you go, has bought credits; enterprise, lifetime, staff: given plans. New plans may appear',
        ),
      left: z.number().nullable().describe('Credits left; null when the plan has no cap'),
      used: z
        .number()
        .describe('Credits used: since the account began, or this month on a given plan'),
      free: z.number().describe('Free credits the account started with'),
      bought: z.number().describe('Credits bought in packs, after refunds'),
      per_month: z
        .number()
        .nullable()
        .describe("A given plan's credits each month; null otherwise"),
      renews: nullableTime.describe("When a given plan's credits renew; null otherwise"),
    })
    .nullable()
    .describe(
      'Credits remove watermarks (export.release, priced by finished length); making is free. Before 2026-11-23 a credit was one minute of a server job or 200 visual judgments, so earlier use counts that way. From the credit ledger; null when the account has no ledger account yet (it never used cuttingfloor) or the ledger did not answer',
    ),
  support_messages: z
    .array(
      z.object({
        at: time,
        message: z.string(),
        improvement: z
          .string()
          .optional()
          .describe('The tooling change the assistant says would have helped, when it gave one'),
      }),
    )
    .describe(
      "Messages the user's assistant sent the cuttingfloor team (support.contact): failures, things it couldn't do, requests, and the tooling change it asks for. Newest first; every one kept",
    ),
  activity: z
    .object({
      calls: z.number().describe('Tool calls, including refused ones'),
      failed: z.number().describe('Tool calls and jobs that ended in an error'),
      jobs: z.number().describe('Long jobs that ended (completed, failed or cancelled)'),
      last_call_at: nullableTime.describe('The latest tool call; null when none in the window'),
      tools: z
        .array(
          z.object({
            tool: z.string(),
            calls: z.number(),
            failed: z.number(),
            jobs: z.number(),
          }),
        )
        .describe('Each tool used, most calls first'),
      recent_errors: z
        .array(
          z.object({
            at: time,
            tool: z.string(),
            code: z.string(),
            message: z.string(),
          }),
        )
        .describe('The latest errors, newest first, up to 20; messages cut at 500 characters'),
      active_days: z.number().describe('Days (UTC) with at least one tool call'),
      longest_streak: z.number().describe('The most days in a row with a tool call'),
    })
    .describe(
      "What the account's assistants did in the last 30 days, from the server's call log (it keeps 30 days; never the arguments or results)",
    ),
  out_of_credits: z
    .object({
      first_at: time.describe('The first call refused for want of credits'),
      last_at: time,
      refusals: z.number(),
    })
    .nullable()
    .describe(
      'Calls refused because the account had too few credits (quota_exceeded: jobs before 2026-11-23, clean-copy releases since), in the last 30 days; null when none',
    ),
  spend: z
    .array(z.object({ tool: z.string(), credits: z.number(), jobs: z.number() }))
    .describe(
      'Server time per tool since the account began, most first, in credits at the rate before 2026-11-23 (a minute of a job, or 200 judgments). Spent only before then: making is free since',
    ),
  releases: z
    .array(
      z.object({
        id: z.string().describe('The export or create.* job_id, or the media_id, released'),
        released_at: time,
        credits: z.number().describe('Credits spent removing the watermark'),
        via: z.enum(['tool', 'rest', 'page']).describe('tool: an agent; rest: an app over /v1'),
      }),
    )
    .describe('Watermarks removed (export.release), newest first; kept 400 days'),
  purchases: z
    .array(
      z.object({
        at: time,
        credits: z.number().describe('Credits in the pack'),
        amount: z.number().describe('Paid, in the currency (dollars, not cents)'),
        refunded: z.number().describe('Refunded, in the currency; 0 when none'),
        currency: z.string().describe('e.g. usd'),
      }),
    )
    .nullable()
    .describe(
      'Packs bought, newest first, from Stripe. Only get_account reads them: null in list pages, and when Stripe did not answer',
    ),
  apps: z
    .array(z.object({ name: z.string(), first_seen_at: time, last_seen_at: time }))
    .describe(
      "Every app the account's requests came from (an MCP client's name, or rest), most recently seen first. Recorded from 2026-11-21; last_seen_at is at most a day behind",
    ),
  files: z.array(AdminFile).describe('Media and finished exports still kept, soonest to go first'),
  next_expiry_at: nullableTime.describe('When the first of files goes; null when none'),
  downloads: z
    .array(AdminDownload)
    .describe(
      'What left through signed links, one entry per file and UTC day, newest first; kept 400 days, after the file itself is gone. Recorded from 2026-11-23',
    ),
  email_prefs: z.object({
    expiry_emails: z.boolean().describe('False when the account turned file reminders off'),
    unsubscribed: z.boolean().describe('Unsubscribed from account email'),
    suppressed: z
      .enum(['bounced', 'complained'])
      .nullable()
      .describe(
        'Why the address must not be emailed: bounced or complained; null when it may be. New reasons may appear',
      ),
  }),
});

export const AdminAccountList = z.object({
  data: z.array(AdminAccount).describe('In the order sort asks: newest first by default'),
  next_cursor: z.string().nullable().describe('Pass as cursor for the next page; null at the end'),
  total: z.number().describe('Accounts in the list, after email or q (with email, 0 or 1)'),
  page: z.number().describe('This page, from 1'),
  pages: z.number().describe('Pages at this limit; at least 1'),
  has_more: z.boolean().describe('True when there is another page'),
  next: z
    .string()
    .nullable()
    .describe('The URL of the next page (page and limit), with the same filters; null at the end'),
});

export const ADMIN_SORTS = ['newest', 'last_active', 'credits', 'exports'] as const;

export const AdminAccountListQuery = z.object({
  cursor: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  email: z.email().optional().describe('Only the account with this email'),
  q: z.string().trim().min(1).max(200).optional().describe('Part of an email or account id'),
  sort: z.enum(ADMIN_SORTS).default('newest'),
});

export const AdminLedgerEntry = z.object({
  id: z
    .string()
    .describe(
      "The entry's id, unique within the account: grant:activation, opening:…, a payment intent (pi_…), a refund (re_…), <job>-release for a spend, adjust:<id> for an admin's adjustment",
    ),
  kind: z
    .enum(['grant', 'opening', 'purchase', 'refund', 'spend', 'adjust'])
    .describe(
      'grant: given (the activation grant); opening: carried over at the split from Kazi; purchase and refund: a pack; spend: a watermark removed; adjust: an admin',
    ),
  credits: z.number().describe('Signed: what the entry added to the balance'),
  at: time,
  balance: z.number().describe('The balance after it'),
  tool: z.string().optional().describe('What spent it (a spend)'),
  pack: z.string().optional().describe('The pack (a purchase or refund)'),
  payment_intent: z.string().optional(),
  reason: z.string().optional().describe('Why (an adjustment or a carry-over)'),
  by: z.string().optional().describe("The admin's WorkOS user id (an adjustment)"),
});

export const AdminLedger = z.object({
  opened: z
    .boolean()
    .describe('False when the account has no ledger account yet (it never used cuttingfloor)'),
  balance: z.number().nullable().describe('Credits held now; null when not opened'),
  entries: z.array(AdminLedgerEntry).describe('Every entry, newest first'),
});

export const AdminAdjustInput = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/)
    .describe(
      'Your id for this adjustment (letters, digits, _ . -; up to 100): sending the same id again changes nothing and answers the first one, so a retry never adds twice. Stored as adjust:<id>',
    ),
  credits: z
    .number()
    .refine((n) => Number.isFinite(n) && n !== 0 && Math.abs(n) <= 100_000, {
      message: 'credits must be a non-zero number up to 100,000 either way',
    })
    .describe('Credits to add (positive) or take away (negative); not zero'),
  reason: z.string().trim().min(1).max(500).describe('Why, kept on the entry for good'),
});

export const AdminAdjustment = z.object({
  entry: AdminLedgerEntry,
  balance: z.number().describe("The account's balance now"),
  duplicate: z
    .boolean()
    .describe('True when this id was written before: nothing changed and entry is the first one'),
});

/** The admin API's named schemas: components/schemas in its OpenAPI document. */
export const adminSchemas = z.registry<{ id: string }>();
adminSchemas.add(AdminError, { id: 'Error' });
adminSchemas.add(AdminMe, { id: 'Me' });
adminSchemas.add(AdminFile, { id: 'File' });
adminSchemas.add(AdminDownload, { id: 'Download' });
adminSchemas.add(AdminAccount, { id: 'Account' });
adminSchemas.add(AdminAccountList, { id: 'AccountList' });
adminSchemas.add(AdminLedgerEntry, { id: 'LedgerEntry' });
adminSchemas.add(AdminLedger, { id: 'Ledger' });
adminSchemas.add(AdminAdjustInput, { id: 'AdjustInput' });
adminSchemas.add(AdminAdjustment, { id: 'Adjustment' });

export type AdminMe = z.infer<typeof AdminMe>;
export type AdminFile = z.infer<typeof AdminFile>;
export type AdminDownload = z.infer<typeof AdminDownload>;
export type AdminAccount = z.infer<typeof AdminAccount>;
export type AdminAccountList = z.infer<typeof AdminAccountList>;
export type AdminLedgerEntry = z.infer<typeof AdminLedgerEntry>;
export type AdminLedger = z.infer<typeof AdminLedger>;
export type AdminAdjustment = z.infer<typeof AdminAdjustment>;
export type AdminSort = (typeof ADMIN_SORTS)[number];

/** The named schemas as OpenAPI 3.1 components, each referring to the others by `$ref`. */
export function adminComponentSchemas(): Record<string, Record<string, unknown>> {
  const { schemas } = z.toJSONSchema(adminSchemas, {
    uri: (id) => `#/components/schemas/${id}`,
  }) as { schemas: Record<string, Record<string, unknown>> };
  for (const schema of Object.values(schemas)) {
    delete schema.$schema;
    delete schema.$id;
  }
  return schemas;
}
