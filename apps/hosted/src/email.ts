import { SUPPORT_EMAIL } from '@cuttingfloor/plans';

// Account email through Resend: a welcome, credits running low, a failed payment. Stripe sends
// receipts and invoices; WorkOS sends sign-in mail. Each message is sent at most once: the caller
// claims a notice file under the data root first (lifecycle.ts), and Resend's idempotency key
// covers a retry of the same send. The sign-up sequence (sequence.ts) sends through
// `EmailProvider`, whose default is `ResendProvider`.

export interface Message {
  to: string;
  subject: string;
  /** Plain paragraphs. */
  lines: string[];
  action?: { label: string; url: string };
  /** Resend's idempotency key: the same key never sends twice within a day. */
  key: string;
}

export class Mailer {
  #key: string;
  #from: string;

  constructor(apiKey: string, from = `cuttingfloor <${SUPPORT_EMAIL}>`) {
    this.#key = apiKey;
    this.#from = from;
  }

  async send(message: Message): Promise<void> {
    const text = [
      ...message.lines,
      ...(message.action ? [`${message.action.label}: ${message.action.url}`] : []),
      '',
      `Questions? Reply to this email or write to ${SUPPORT_EMAIL}.`,
    ].join('\n\n');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#key}`,
        'content-type': 'application/json',
        'idempotency-key': message.key.slice(0, 256),
      },
      body: JSON.stringify({
        from: this.#from,
        to: [message.to],
        reply_to: SUPPORT_EMAIL,
        subject: message.subject,
        text,
        html: html(message),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** One plain-text email, as the sign-up sequence sends it. */
export interface OutboundEmail {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
  /** The same key never sends twice, where the provider supports it. */
  idempotencyKey: string;
}

/** Where email goes out. Resend by default; anything that can send one message fits. */
export interface EmailProvider {
  /** Resolves with the provider's message id. Throws `EmailError`. */
  send(email: OutboundEmail): Promise<{ id: string }>;
}

export class EmailError extends Error {
  /** Sending it again won't help (a refused address, a bad request). */
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean) {
    super(message);
    this.permanent = permanent;
  }
}

export class ResendProvider implements EmailProvider {
  #key: string;

  constructor(apiKey: string) {
    this.#key = apiKey;
  }

  async send(email: OutboundEmail): Promise<{ id: string }> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#key}`,
        'content-type': 'application/json',
        'idempotency-key': email.idempotencyKey.slice(0, 256),
      },
      body: JSON.stringify({
        from: email.from,
        to: [email.to],
        reply_to: email.replyTo,
        subject: email.subject,
        text: email.text,
        headers: email.headers,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = `Resend ${res.status}: ${(await res.text()).slice(0, 200)}`;
      throw new EmailError(detail, res.status >= 400 && res.status < 500 && res.status !== 429);
    }
    const { id } = (await res.json()) as { id?: string };
    if (!id) throw new EmailError('Resend answered without a message id', false);
    return { id };
  }
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

function html(message: Message): string {
  const paragraphs = message.lines
    .map((line) => `<p style="margin:0 0 16px">${esc(line)}</p>`)
    .join('');
  const button = message.action
    ? `<p style="margin:24px 0"><a href="${esc(message.action.url)}" style="background:#00b140;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600">${esc(message.action.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f6f5f2;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111"><div style="max-width:520px;margin:0 auto;background:#fff;border-radius:10px;padding:32px"><p style="margin:0 0 24px;font-weight:700">cuttingfloor</p>${paragraphs}${button}<p style="margin:24px 0 0;color:#666;font-size:14px">Questions? Reply to this email or write to <a href="mailto:${SUPPORT_EMAIL}" style="color:#666">${SUPPORT_EMAIL}</a>.</p></div></body></html>`;
}
