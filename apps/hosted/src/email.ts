import { SUPPORT_EMAIL } from '@cuttingfloor/plans';

// Account email through Resend: trial ending, minutes running low, a failed payment. Stripe sends
// receipts and invoices; WorkOS sends sign-in mail. Each message is sent at most once: the caller
// claims a notice file under the data root first (lifecycle.ts), and Resend's idempotency key
// covers a retry of the same send.

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
