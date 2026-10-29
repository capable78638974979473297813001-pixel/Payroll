import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../lib/errors.ts';
import type { StripeEvent } from './service.ts';

/**
 * Verify a Stripe webhook the way Stripe documents it: the `Stripe-Signature`
 * header carries a timestamp `t` and one or more `v1` signatures, each an
 * HMAC-SHA256 of `${t}.${rawBody}` keyed with the endpoint's signing secret (or any of several, when one server receives
 * from more than one endpoint).
 * The raw bytes must be used, not re-serialised JSON. A timestamp older than
 * the tolerance is refused so a captured request cannot be replayed later.
 */
export function constructEvent(rawBody: string, header: string | undefined, secretOrSecrets: string | readonly string[], nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): StripeEvent {
  const secrets = (Array.isArray(secretOrSecrets) ? secretOrSecrets : [secretOrSecrets as string]).filter(Boolean);
  if (secrets.length === 0) throw new ApiError(500, 'webhook_not_configured', 'STRIPE_WEBHOOK_SECRET is not set, so webhooks cannot be verified.');
  if (!header) throw new ApiError(400, 'bad_signature', 'Missing Stripe-Signature header');
  let t = '';
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') t = v;
    else if (k === 'v1' && v) sigs.push(v);
  }
  const ts = Number(t);
  if (!t || !Number.isFinite(ts) || sigs.length === 0) throw new ApiError(400, 'bad_signature', 'Malformed Stripe-Signature header');
  if (Math.abs(nowSeconds - ts) > toleranceSeconds) throw new ApiError(400, 'bad_signature', 'Webhook timestamp is outside the tolerance');
  // Stripe gives each webhook endpoint its own secret (a Connect endpoint has a different one), so any configured secret may match.
  const ok = secrets.some((secret) => {
    const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
    return sigs.some((s) => {
      const given = Buffer.from(s, 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
  });
  if (!ok) throw new ApiError(400, 'bad_signature', 'Webhook signature does not match');
  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw new ApiError(400, 'bad_payload', 'Webhook body is not JSON');
  }
  if (!event?.id || !event?.type || !event?.data?.object) throw new ApiError(400, 'bad_payload', 'Webhook body is not a Stripe event');
  return event;
}

/** Sign a payload the way Stripe does. For tests and local webhook replays. */
export function signPayload(rawBody: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', secret).update(`${nowSeconds}.${rawBody}`).digest('hex');
  return `t=${nowSeconds},v1=${sig}`;
}
