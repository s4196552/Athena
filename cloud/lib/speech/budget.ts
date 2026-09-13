import 'server-only';
import { cookies } from 'next/headers';

/* Spending controls on the speech key.
 *
 * Deliberately NOT lib/brief/budget.ts, and the reason is the unit. Gemini
 * bills tokens on a call whose size this server fixes, so counting calls is a
 * fair proxy there. ElevenLabs bills CHARACTERS. Counting calls would price a
 * forty-character title the same as a two-thousand-character brief, which gets
 * the cap wrong in both directions at once -- generous to the expensive case,
 * mean to the cheap one.
 *
 * Sharing the brief's counter would also mean that listening to a summary
 * spends the allowance for writing one. Two vendors, two keys, two bills; one
 * counter would make the cheaper of them unavailable because of the other.
 *
 * The layers mirror the brief's, and layer 3 is again the only real bound:
 *
 *   1. A per-viewer daily character counter in a cookie. Stops ordinary
 *      over-use. Someone determined clears it -- a speed bump, labelled as one.
 *   2. A per-instance daily counter. Bounds a burst against one warm lambda.
 *   3. THE PAYLOAD. Every call speaks a brief this server built from the
 *      catalogue, truncated by MAX_SPEECH_CHARS before it is sent. A caller
 *      cannot make a request longer, because a caller does not supply the text.
 *
 * Anyone putting a key behind a genuinely public deployment should also set a
 * usage limit in the ElevenLabs dashboard, and .env.example says so.
 */

const COOKIE = 'athena_tts_use';

/* Roughly four briefs a day per viewer at the 2,000-character cap below. High
 * enough that nobody demoing the feature hits it, low enough that a script
 * hammering the endpoint runs out in a minute. */
export const PER_VIEWER_DAILY_CHARS = Number(process.env.ATHENA_TTS_VIEWER_DAILY ?? 8_000);
export const PER_INSTANCE_DAILY_CHARS = Number(process.env.ATHENA_TTS_DAILY_MAX ?? 150_000);

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

let instanceDay = today();
let instanceUsed = 0;

export interface SpeechBudget {
  allowed: boolean;
  reason?: string;
  viewerUsed: number;
  viewerLimit: number;
}

/** Checked before the call, with the exact length about to be sent. `spend` is
 *  separate, so a synthesis that failed does not bill a viewer for audio they
 *  never heard. */
export async function checkSpeechBudget(chars: number): Promise<SpeechBudget> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value ?? '';
  const [day, count] = raw.split(':');
  const used = day === today() ? Number(count) || 0 : 0;

  if (instanceDay !== today()) {
    instanceDay = today();
    instanceUsed = 0;
  }

  if (used + chars > PER_VIEWER_DAILY_CHARS) {
    return {
      allowed: false,
      // Says how to proceed, not just that it stopped: the brief itself is
      // still on screen and still free to read.
      reason: 'That is as much audio as this demo reads for one visitor in a day. '
        + 'The summary itself is still here, and costs nothing to read.',
      viewerUsed: used,
      viewerLimit: PER_VIEWER_DAILY_CHARS,
    };
  }

  if (instanceUsed + chars > PER_INSTANCE_DAILY_CHARS) {
    return {
      allowed: false,
      reason: 'This deployment has reached its daily budget for reading summaries '
        + 'aloud. The summary itself is still here, and costs nothing to read.',
      viewerUsed: used,
      viewerLimit: PER_VIEWER_DAILY_CHARS,
    };
  }

  return { allowed: true, viewerUsed: used, viewerLimit: PER_VIEWER_DAILY_CHARS };
}

/** Called only after ElevenLabs actually returned audio. */
export async function spendSpeech(chars: number): Promise<void> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value ?? '';
  const [day, count] = raw.split(':');
  const used = day === today() ? Number(count) || 0 : 0;

  instanceUsed += chars;
  jar.set(COOKIE, `${today()}:${used + chars}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 48 * 60 * 60,
  });
}

/* Listening to the same selection twice costs one synthesis, not two -- the
 * same reasoning as the brief's prose cache, and it matters more here because
 * replaying audio is a thing people actually do. Module memory rather than a
 * table because there is no database; it survives as long as the instance does,
 * which is enough to absorb someone pressing play again.
 *
 * Capped by total bytes rather than entry count: entries are ~40 KB of mp3
 * each, and a 200-entry cache of those is 8 MB of lambda memory held for half
 * an hour. Counting what is actually scarce is the point of a cap. */
const cache = new Map<string, { audio: ArrayBuffer; at: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_BYTES = 12 * 1024 * 1024;
let cacheBytes = 0;

export function cachedAudio(key: string): ArrayBuffer | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    cacheBytes -= hit.audio.byteLength;
    return undefined;
  }
  return hit.audio;
}

export function rememberAudio(key: string, audio: ArrayBuffer): void {
  // Oldest first. Map preserves insertion order, so this is the FIFO the
  // access pattern wants -- a brief is replayed within minutes or not at all,
  // which is not enough re-reading to earn LRU bookkeeping.
  while (cacheBytes + audio.byteLength > CACHE_MAX_BYTES && cache.size) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheBytes -= cache.get(oldest)?.audio.byteLength ?? 0;
    cache.delete(oldest);
  }
  cache.set(key, { audio, at: Date.now() });
  cacheBytes += audio.byteLength;
}
