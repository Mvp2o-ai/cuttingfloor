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
      "What the user wants to make with video, one sentence their assistant gave when it activated the free credits; null when it hasn't",
    ),
  use_case_at: nullableTime.describe('When the assistant activated the free credits'),
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
      'A credit is one minute of a server job (an export, a transcript) or 200 visual judgments. From the credit ledger; null when the account has no ledger account yet (it never used cuttingfloor) or the ledger did not answer',
    ),
  files: z.array(AdminFile).describe('Media and finished exports still kept, soonest to go first'),
  next_expiry_at: nullableTime.describe('When the first of files goes; null when none'),
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
  data: z.array(AdminAccount).describe('Newest accounts first'),
  next_cursor: z.string().nullable().describe('Pass as cursor for the next page; null at the end'),
});

export const AdminAccountListQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  email: z.email().optional().describe('Only the account with this email'),
});

/** The admin API's named schemas: components/schemas in its OpenAPI document. */
export const adminSchemas = z.registry<{ id: string }>();
adminSchemas.add(AdminError, { id: 'Error' });
adminSchemas.add(AdminMe, { id: 'Me' });
adminSchemas.add(AdminFile, { id: 'File' });
adminSchemas.add(AdminAccount, { id: 'Account' });
adminSchemas.add(AdminAccountList, { id: 'AccountList' });

export type AdminMe = z.infer<typeof AdminMe>;
export type AdminFile = z.infer<typeof AdminFile>;
export type AdminAccount = z.infer<typeof AdminAccount>;

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
