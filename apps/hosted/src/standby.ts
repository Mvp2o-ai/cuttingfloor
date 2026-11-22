import { Mailer } from './email.ts';
import type { Lifecycle } from './lifecycle.ts';
import type { Sequence } from './sequence.ts';

// A standby server (CUTTINGFLOOR_STANDBY=1) runs beside the one in production on a copy of its
// data, until the cutover. It answers every request as usual, so it can be used as a client
// would use it, and does nothing to the data by the clock: the copy's "last used" times are only
// as fresh as the last copy, so a sweep would remove what production still keeps, and a reminder
// or a sequence email would reach people a second time. Unset, nothing here changes anything.

/** The one line a standby server logs as it starts: that it is one, and what that turns off. */
export const STANDBY_NOTICE =
  'standby: CUTTINGFLOOR_STANDBY=1. This server answers requests and does nothing by the clock: no sweep at start or by the hour (timelines, media, jobs, outputs, uploads, meter, call log, sign-in steps), no recovery of interrupted jobs at start or by the minute, no lifecycle sweep (new accounts, welcome and expiry notices, key and partner-link sweeps, ledger spend catch-up), no email sequence, and no email of any kind (no mailer is made). Unset it and restart at the cutover.';

/**
 * The mailer for account email, from the environment. None on a standby server, whatever keys
 * its environment holds: nothing it does may send an email.
 */
export function accountMailer(env: NodeJS.ProcessEnv, standby: boolean): Mailer | undefined {
  if (standby || !env.RESEND_API_KEY) return undefined;
  // Account email comes from the same person as the sign-up sequence, when one is set.
  return new Mailer(env.RESEND_API_KEY, {
    ...(env.CUTTINGFLOOR_EMAIL_FROM ? { from: env.CUTTINGFLOOR_EMAIL_FROM } : {}),
    ...(env.CUTTINGFLOOR_EMAIL_REPLY_TO ? { replyTo: env.CUTTINGFLOOR_EMAIL_REPLY_TO } : {}),
  });
}

/**
 * Starts what a hosted server does beside answering requests. The lifecycle always hears this
 * server's own calls and jobs; its sweep by the clock, and the email sequence (`sequence` makes
 * it, and is not even asked to on standby), run only on a server that is not one.
 */
export function startBackground(options: {
  standby: boolean;
  lifecycle?: Pick<Lifecycle, 'start'> | undefined;
  sequence?: () => Sequence | undefined;
}): Sequence | undefined {
  options.lifecycle?.start({ sweep: !options.standby });
  if (options.standby) return undefined;
  const sequence = options.sequence?.();
  sequence?.start();
  return sequence;
}
