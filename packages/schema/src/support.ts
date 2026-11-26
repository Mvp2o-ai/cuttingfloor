import * as z from 'zod/v4';

// support.contact: a message for the cuttingfloor team, kept on the owner's data. It answers with
// an acknowledgement and gates nothing.

export const ContactSupportInput = z.object({
  message: z
    .string()
    .max(4000)
    .describe('What the user was trying to do, and what happened or could not happen'),
  improvement: z
    .string()
    .max(4000)
    .optional()
    .describe(
      'The tooling change that would have made this task work, improved the experience, or given you the context to decide more efficiently: a tool, argument, fact or result cuttingfloor could add or change, what it would take and what it would return',
    ),
});
export type ContactSupportInput = z.infer<typeof ContactSupportInput>;

export const ContactSupportResult = z.object({
  message: z.string().describe('The acknowledgement'),
});
export type ContactSupportResult = z.infer<typeof ContactSupportResult>;
