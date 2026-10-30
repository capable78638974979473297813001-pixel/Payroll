/**
 * Email, sent through Resend's HTTP API with plain fetch (no SDK), ported from the earlier Omnia.tax site.
 *
 * With RESEND_API_KEY set, messages go through Resend. Without it, messages are kept in memory and written to
 * the server log (never the code itself in production), so signup still works on a laptop. Nothing anywhere
 * claims a message was delivered when it was not: every send returns { sent, reason }.
 */

export interface Message {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface SendResult {
  sent: boolean;
  reason?: string;
}

export interface Mailer {
  readonly kind: 'resend' | 'outbox';
  send(m: Message): Promise<SendResult>;
}

/** Resend's shared test sender: delivers only to the Resend account owner. */
export const RESEND_TEST_SENDER = 'Totali <onboarding@resend.dev>';

/** A log-safe line: strips API keys, bearer tokens and 6-digit codes. */
export function scrubMailLog(text: string): string {
  return text
    .replace(/re_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b\d{6}\b/g, '[code]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300);
}

export function domainNotVerified(status: number, body: string): boolean {
  const t = body.toLowerCase();
  return (status === 403 || status === 422) && t.includes('domain') && t.includes('verif');
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The From address. RESEND_FROM may be a bare address (sent as "Totali <address>") or a full "Name <address>". */
export function fromAddress(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.RESEND_FROM ?? '').trim().replace(/^['"]|['"]$/g, '').trim();
  if (raw) return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(raw) ? `Totali <${raw}>` : raw;
  try {
    const host = new URL(env.PUBLIC_BASE_URL ?? '').hostname.replace(/^www\./, '');
    if (host.includes('.') && host !== 'localhost' && host !== '127.0.0.1') return `Totali <verify@${host}>`;
  } catch { /* no public base url */ }
  return RESEND_TEST_SENDER;
}

export class ResendMailer implements Mailer {
  readonly kind = 'resend' as const;
  private readonly apiKey: string;
  private readonly base: string;
  private readonly from: () => string;
  private readonly fetcher: typeof fetch;
  private readonly log: (m: string) => void;

  constructor(opts: { apiKey: string; apiBase?: string; from?: () => string; fetcher?: typeof fetch; log?: (m: string) => void }) {
    this.apiKey = opts.apiKey;
    this.base = (opts.apiBase ?? 'https://api.resend.com').replace(/\/+$/, '');
    this.from = opts.from ?? (() => fromAddress());
    this.fetcher = opts.fetcher ?? fetch;
    this.log = opts.log ?? (() => {});
  }

  private post(m: Message, from: string): Promise<Response> {
    return this.fetcher(`${this.base}/emails`, {
      method: 'POST',
      // A default fetch user agent is rejected by Resend's edge with 403.
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'totali/1.0' },
      body: JSON.stringify({ from, to: [m.to], subject: m.subject, html: m.html, text: m.text, ...(m.replyTo ? { reply_to: m.replyTo } : {}) }),
    });
  }

  async send(m: Message): Promise<SendResult> {
    const from = this.from();
    try {
      let res = await this.post(m, from);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // The sending domain is not verified yet. Resend's own test address still reaches the account owner, which
        // lets the owner sign in while the domain is being verified. Anyone else gets the same failure.
        if (from !== RESEND_TEST_SENDER && domainNotVerified(res.status, body)) {
          this.log('sending domain is not verified in Resend; retrying from its test address (reaches only the Resend account owner)');
          res = await this.post(m, RESEND_TEST_SENDER);
          if (res.ok) return { sent: true };
          return { sent: false, reason: scrubMailLog(`Resend responded ${res.status}: ${await res.text().catch(() => '')}`) };
        }
        return { sent: false, reason: scrubMailLog(`Resend responded ${res.status}: ${body}`) };
      }
      return { sent: true };
    } catch (err) {
      return { sent: false, reason: scrubMailLog(err instanceof Error ? err.message : 'Unknown error calling Resend.') };
    }
  }
}

/** Keeps messages in memory. For development and tests; reports sent:false so nothing claims a delivery. */
export class OutboxMailer implements Mailer {
  readonly kind = 'outbox' as const;
  readonly messages: Array<Message & { at: string }> = [];
  private readonly log: (m: string) => void;
  constructor(log: (m: string) => void = () => {}) {
    this.log = log;
  }
  async send(m: Message): Promise<SendResult> {
    this.messages.push({ ...m, at: new Date().toISOString() });
    if (this.messages.length > 200) this.messages.shift();
    this.log(`email not sent (no RESEND_API_KEY): "${scrubMailLog(m.subject)}" kept in the outbox`);
    return { sent: false, reason: 'RESEND_API_KEY is not set, so the message was kept in the outbox and not sent.' };
  }
}

export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env, log: (m: string) => void = () => {}): Mailer {
  const key = (env.RESEND_API_KEY ?? '').trim();
  if (!key) return new OutboxMailer(log);
  return new ResendMailer({ apiKey: key, ...(env.RESEND_API_BASE ? { apiBase: env.RESEND_API_BASE } : {}), from: () => fromAddress(env), log });
}

// ---------------------------------------------------------------- the messages Totali sends

const wrap = (heading: string, body: string, foot: string) => `
<div style="font-family:'Inter Tight',Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 8px;color:#0A0A0A">
  <p style="font-family:'JetBrains Mono',Menlo,Consolas,monospace;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#1F3BFF;margin:0 0 18px">Totali</p>
  <h1 style="font-size:24px;font-weight:700;margin:0 0 12px;letter-spacing:-.02em">${heading}</h1>
  ${body}
  <p style="font-size:12.5px;color:#6E7079;margin:24px 0 0;border-top:1px solid #E1E3E8;padding-top:12px">${foot}</p>
</div>`.trim();

const para = (t: string) => `<p style="font-size:15px;line-height:1.6;color:#6E7079;margin:0 0 22px">${t}</p>`;
const button = (href: string, label: string) => `<p style="margin:0 0 22px"><a href="${escapeHtml(href)}" style="display:inline-block;background:#1F3BFF;color:#FFFFFF;font-weight:700;text-decoration:none;padding:14px 24px">${escapeHtml(label)}</a></p>`;

export function verificationEmail(a: { to: string; firstName: string; code: string; expiresAt: string; now?: Date }): Message {
  const minutes = Math.max(1, Math.round((new Date(a.expiresAt).getTime() - (a.now ?? new Date()).getTime()) / 60_000));
  const name = escapeHtml(a.firstName);
  const html = wrap(
    `Confirm your email, ${name}`,
    `${para(`Use this code to verify your email. It expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`)}<div style="font-family:'JetBrains Mono',Menlo,Consolas,monospace;font-size:30px;font-weight:700;letter-spacing:.34em;background:#0A0A0A;color:#FFFFFF;text-align:center;padding:18px 8px">${escapeHtml(a.code)}</div>`,
    'If you didn’t ask for it, you can ignore this email. Nothing happens without the code. Totali is a product of OMNIA TAX LLC.',
  );
  return { to: a.to, subject: 'Your verification code', html, text: `Hi ${a.firstName}, your Totali verification code is ${a.code}. It expires in ${minutes} minute(s). If you didn’t ask for it, ignore this email.` };
}

export function inviteEmail(a: { to: string; firstName: string; businessName: string; link: string; forms: string[] }): Message {
  const forms = a.forms.map((f) => `<li>${escapeHtml(f)}</li>`).join('');
  const html = wrap(
    `Welcome to ${escapeHtml(a.businessName)}, ${escapeHtml(a.firstName)}`,
    `${para(`${escapeHtml(a.businessName)} uses Totali for payroll. Please fill in your new-hire forms. It takes a few minutes and works on your phone.`)}<ul style="font-size:15px;line-height:1.8;color:#0A0A0A;margin:0 0 22px;padding-left:20px">${forms}</ul>${button(a.link, 'Start your forms')}`,
    'This link is just for you. Don’t forward it. If you weren’t expecting this, you can ignore it.',
  );
  return { to: a.to, subject: `${a.businessName}: your new-hire forms`, html, text: `${a.businessName} uses Totali for payroll. Fill in your new-hire forms (${a.forms.join(', ')}): ${a.link}\nThis link is just for you.` };
}

export function reminderEmail(a: { to: string; firstName: string; businessName: string; link: string; missing: string[] }): Message {
  const items = a.missing.map((f) => `<li>${escapeHtml(f)}</li>`).join('');
  const html = wrap(
    `A reminder from ${escapeHtml(a.businessName)}`,
    `${para(`Hi ${escapeHtml(a.firstName)}, a few things are still missing before you can be paid:`)}<ul style="font-size:15px;line-height:1.8;color:#0A0A0A;margin:0 0 22px;padding-left:20px">${items}</ul>${button(a.link, 'Finish your forms')}`,
    'This link is just for you. Don’t forward it.',
  );
  return { to: a.to, subject: `${a.businessName}: still missing ${a.missing.join(', ')}`, html, text: `Hi ${a.firstName}, still missing: ${a.missing.join(', ')}. Finish here: ${a.link}` };
}
