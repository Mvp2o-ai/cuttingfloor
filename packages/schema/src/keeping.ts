// How long the server keeps each kind of thing: the one source for the sweeps, the server's
// instructions, tool descriptions and the expiry every file's details carry. Nothing is kept
// for good; the agent keeps what lasts on its side.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How long anything stays on the cutting floor: one span for everything, links included. */
export const KEEP = 7 * DAY;

export const KEEP_MS = {
  /** A timeline, after it was last used. */
  timeline: KEEP,
  /** Imported and created media, after it was last used (any read or edit is a use). */
  media: KEEP,
  /** A finished job and its output (an export), after it finished. */
  job: KEEP,
  /** A file sent to the server and not imported, after its upload began. */
  upload: KEEP,
} as const;

/** A span in words: "24 hours", "7 days". */
export function span(ms: number): string {
  if (ms < 48 * HOUR) {
    const hours = Math.max(1, Math.round(ms / HOUR));
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  const days = Math.round(ms / DAY);
  return `${days} days`;
}

/** The keeping policy in one sentence, for the instructions and descriptions. */
export const KEEPING = `everything goes ${span(KEEP)} after last use (exports after they finish, uploads after sending; each file's details say when)`;

/**
 * When a file goes, in a sentence: "Expires in 5 days, on 2026-11-19 14:00 UTC; …". `then` says
 * what keeps it longer or how to keep it.
 */
export function expiry(until: number, then: string, now = Date.now()): string {
  return `${expiryHead(until, now)}; ${then}.`;
}

/** An `expiry` sentence said again as of `now`, from the time it names; read back from a stored result. */
export function restateExpiry(sentence: string, until: number, now = Date.now()): string {
  return sentence.replace(/^[^;]*/, expiryHead(until, now));
}

function expiryHead(until: number, now: number): string {
  const left = until - now;
  const when = `${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  if (left <= 0) return `Expired at ${when}`;
  if (left < HOUR) return `Expires in under an hour, at ${when}`;
  return `Expires in ${span(left)}, on ${when}`;
}

/** What keeps each kind of file longer, or how to keep it, as `expiry` takes it. */
export const KEEP_THEN = {
  media: `any use keeps it ${span(KEEP_MS.media)} from then. Save the file from its url to keep it for good`,
  job: 'save the file from its url to keep it',
  upload: 'media.import it before then to keep it',
} as const;
