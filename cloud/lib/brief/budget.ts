import 'server-only';
import { cookies } from 'next/headers';

/* Spending controls on one shared API key.
 *
 * This is a public demo. Anyone who can reach the login screen can sign in as
 * a fixture account, and every one of them would be spending the same key. So
 * the question is not whether to cap it but where the cap can actually live,
 * on a platform with no shared memory between lambda instances.
 *
 * Three layers, weakest to strongest, and it is worth being clear that only
 * the third is a real bound:
 *
 *   1. A per-viewer daily counter in a cookie. Stops ordinary over-use. A
 *      determined person clears it, and that is fine -- it is a speed bump,
 *      labelled as one, not a security control.
 *   2. A per-instance daily counter. Catches a runaway client hitting one warm
 *      lambda in a loop. Resets on a cold start and is not shared between
 *      instances, so it bounds a burst rather than a day.
 *   3. THE PAYLOAD ITSELF. Every call sends a few hundred tokens of aggregated
 *      counts and asks for at most 700 back. There is no per-file text and no
 *      way for a caller to make a request bigger, because the caller does not
 *      supply the content -- the server builds the digest from the catalogue.
 *      A worst case here is a large number of very small calls, which is a
 *      recoverable bill, not an open-ended one.
 *
 * The honest summary: 1 and 2 keep the demo tidy; 3 is what makes the exposure
 * bounded. Anyone putting a key behind a genuinely public deployment should set
 * a spending limit in Google AI Studio as well, and the README says so.
 */

const COOKIE = 'athena_ai_use';

export const PER_VIEWER_DAILY = Number(process.env.ATHENA_AI_VIEWER_DAILY ?? 25);
export const PER_INSTANCE_DAILY = Number(process.env.ATHENA_AI_DAILY_MAX ?? 400);

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

let instanceDay = today();
let instanceUsed = 0;

export interface BudgetVerdict {
  allowed: boolean;
  reason?: string;
  viewerUsed: number;
  viewerLimit: number;
}

/** Checked before the call. `spend` is separate, so a failed call does not
 *  consume a viewer's allowance for the day. */
export async function checkBudget(): Promise<BudgetVerdict> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value ?? '';
  const [day, count] = raw.split(':');
  const used = day === today() ? Number(count) || 0 : 0;

  if (instanceDay !== today()) {
    instanceDay = today();
    instanceUsed = 0;
  }

  if (used >= PER_VIEWER_DAILY) {
    return {
      allowed: false,
      reason: `You have used today's ${PER_VIEWER_DAILY} model-written summaries. `
        + 'The counted summary below needs no model and has no limit.',
      viewerUsed: used,
      viewerLimit: PER_VIEWER_DAILY,
    };
  }
  if (instanceUsed >= PER_INSTANCE_DAILY) {
    return {
      allowed: false,
      reason: 'This deployment has reached its daily model budget. '
        + 'The counted summary below needs no model and has no limit.',
      viewerUsed: used,
      viewerLimit: PER_VIEWER_DAILY,
    };
  }
  return { allowed: true, viewerUsed: used, viewerLimit: PER_VIEWER_DAILY };
}

/** Called only after a call actually succeeded. */
export async function spend(): Promise<void> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value ?? '';
  const [day, count] = raw.split(':');
  const used = day === today() ? Number(count) || 0 : 0;

  instanceUsed++;
  jar.set(COOKIE, `${today()}:${used + 1}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 48 * 60 * 60,
  });
}

/* Answering the same selection twice costs one call, not two -- the same
 * reasoning as the `brief` table in athena/db/schema.sql, which is keyed by
 * the canonical filter string for exactly this purpose. Module memory rather
 * than a table because there is no database here; it survives as long as the
 * instance does, which is enough to absorb a person clicking twice. */
const cache = new Map<string, { prose: unknown; at: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 200;

export function cached<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.prose as T;
}

export function remember(key: string, prose: unknown): void {
  if (cache.size >= CACHE_MAX) {
    // Oldest first. Map preserves insertion order, so this is the FIFO the
    // access pattern actually wants -- briefs are not re-read often enough for
    // LRU bookkeeping to earn its complexity.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { prose, at: Date.now() });
}
