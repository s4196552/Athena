import 'server-only';

/* The site's one speech call.
 *
 * Athena's brief answers "what is this selection?" in prose. This reads that
 * answer out loud -- which is the one thing a summary is genuinely better for
 * than a table, because a person can listen to a paragraph while looking at
 * the files it describes.
 *
 * WHAT LEAVES THIS SERVER, stated as plainly as lib/ai/gemini.ts states it:
 * the text of a brief this server just produced. Nothing else. In particular
 * THE CALLER DOES NOT SUPPLY THE TEXT -- app/api/w/[ws]/speak/route.ts rebuilds
 * the brief from the catalogue and speaks that. This is not a style choice. An
 * endpoint that speaks whatever it is posted is a free text-to-speech proxy for
 * anyone who can reach a login screen, billed to one shared key, and no
 * per-call length cap fixes it, because the abuse is unlimited CALLS of legal
 * length. Deriving the text server-side is what makes the exposure bounded.
 *
 * `server-only` is load-bearing for the same reason it is in gemini.ts: an
 * accidental import from a client component would put the key in the browser
 * bundle, and this file failing the build is how that gets caught rather than
 * shipped. tests/verify.mjs asserts the key never appears in a served script.
 */

const BASE = 'https://api.elevenlabs.io/v1';

/* Flash is the right default for this workload, and the tempting answer is the
 * wrong one. The brief is read once, in a browser, by someone looking at a file
 * list while it plays -- there is no performance being given, so the expressive
 * models buy nothing here. Flash bills at half the character rate of the v2
 * models and returns in well under a second, which is the difference between a
 * button that feels broken and one that does not. Overridable, because model
 * ids move faster than deploys do. */
export const SPEECH_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';

/* Rachel, one of the stock voices present on every account including the free
 * tier. A cloned or premium voice id would work here and then 404 for anyone
 * else deploying this with their own key, so the default is the one that is
 * always there. */
export const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

/* 128 kbps mp3 is the ElevenLabs default and the highest bitrate not gated
 * behind a paid tier. Higher would 400 on a free key -- a failure that reads
 * as "speech is broken" rather than "your plan does not include that". */
const OUTPUT_FORMAT = process.env.ELEVENLABS_FORMAT || 'mp3_44100_128';

export const SPEECH_MIME = 'audio/mpeg';

export function elevenLabsKey(): string | undefined {
  const key = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_LABS_API_KEY;
  return key && key.trim() ? key.trim() : undefined;
}

/** Presence only, never the value -- the same rule /api/health follows for
 *  AUTH_SECRET and GEMINI_API_KEY. */
export function elevenLabsStatus(): {
  configured: boolean; model: string; voice: string; reason?: string;
} {
  return elevenLabsKey()
    ? { configured: true, model: SPEECH_MODEL, voice: VOICE_ID }
    : {
        configured: false,
        model: SPEECH_MODEL,
        voice: VOICE_ID,
        reason: 'ELEVENLABS_API_KEY is not set',
      };
}

export class SpeechError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'SpeechError';
  }
}

/* Longer than the 20s Gemini gets. Synthesis time scales with the length of
 * the text rather than being roughly constant, and a two-thousand-character
 * brief is a minute and a half of audio to produce. */
const TIMEOUT_MS = 30_000;

/** Synthesise one passage. Returns the mp3 bytes; the caller decides how they
 *  reach a browser. Never called with caller-supplied text -- see the header. */
export async function speak(text: string): Promise<ArrayBuffer> {
  const key = elevenLabsKey();
  if (!key) throw new SpeechError('ELEVENLABS_API_KEY is not set');

  const clean = text.trim();
  if (!clean) throw new SpeechError('There is nothing to read.');

  const res = await fetch(
    `${BASE}/text-to-speech/${encodeURIComponent(VOICE_ID)}?output_format=${OUTPUT_FORMAT}`,
    {
      method: 'POST',
      // The key goes in a header, never the query string, for the reason
      // gemini.ts gives: a URL with a credential in it ends up in logs,
      // proxies and error messages, and a header does not.
      headers: { 'Content-Type': 'application/json', 'xi-api-key': key },
      body: JSON.stringify({
        text: clean,
        model_id: SPEECH_MODEL,
        /* Deliberately close to the defaults. This is a document being read
           aloud, not a character being performed: stability high enough that
           the same brief does not sound different on a second listen, and
           style at zero, because inflection the text never called for is how a
           summary starts sounding like an advert. */
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    },
  );

  if (!res.ok) {
    // ElevenLabs returns JSON errors even from the audio endpoint, and its
    // messages are specific enough to act on -- quota_exceeded and
    // invalid_api_key are different problems with different fixes.
    const body = (await res.text()).slice(0, 300);
    const detail = (() => {
      try {
        const parsed = JSON.parse(body);
        return parsed?.detail?.message ?? parsed?.detail?.status ?? parsed?.detail;
      } catch {
        return undefined;
      }
    })();
    throw new SpeechError(
      `ElevenLabs returned ${res.status}: ${typeof detail === 'string' ? detail : body}`,
      res.status,
    );
  }

  const audio = await res.arrayBuffer();
  if (audio.byteLength === 0) throw new SpeechError('ElevenLabs returned no audio');
  return audio;
}

/* A fingerprint, not the key -- the reasoning is spelled out in gemini.ts and
 * applies unchanged: when a credential works from a laptop and is refused from
 * a lambda, it is almost always because the two are not the same string. */
function fingerprint(key: string) {
  return {
    length: key.length,
    starts: key.slice(0, 3),
    ends: key.slice(-4),
    clean: key === key.trim() && !/["'\s]/.test(key),
  };
}

/* Does ElevenLabs accept this key, from this server, right now?
 *
 * `/v1/voices` rather than a synthesis call, for the reason /api/health probes
 * Gemini with models.list: it needs the same credential, costs no characters,
 * and cannot be turned into a way to spend the key by hitting the health
 * endpoint in a loop.
 *
 * The subscription read is separate and best-effort. Character quota is the
 * number that actually predicts when speech will stop working, so it is worth
 * reporting -- but `user_read` is a scope a restricted key can legitimately
 * lack, and a probe that failed a WORKING key over a missing scope would be a
 * worse probe than one that simply omits the quota.
 */
export async function probeElevenLabs(): Promise<{
  ok: boolean;
  model: string;
  voice: string;
  status?: number;
  detail?: string;
  key?: ReturnType<typeof fingerprint>;
  quota?: { used: number; limit: number; tier?: string };
}> {
  const raw = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_LABS_API_KEY || '';
  const key = elevenLabsKey();
  const head = { model: SPEECH_MODEL, voice: VOICE_ID };
  if (!key) return { ok: false, ...head, detail: 'ELEVENLABS_API_KEY is not set' };
  const print = fingerprint(raw);

  try {
    const res = await fetch(`${BASE}/voices?page_size=1`, {
      headers: { 'xi-api-key': key },
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });

    if (!res.ok) {
      const body = await res.text();
      const message = (() => {
        try {
          return JSON.parse(body)?.detail?.message;
        } catch {
          return undefined;
        }
      })();
      return {
        ok: false,
        ...head,
        status: res.status,
        detail: (message ?? body).slice(0, 200),
        key: print,
      };
    }

    return { ok: true, ...head, status: res.status, key: print, quota: await quota(key) };
  } catch (err) {
    return {
      ok: false,
      ...head,
      key: print,
      detail: err instanceof Error ? err.message.slice(0, 200) : 'request failed',
    };
  }
}

async function quota(key: string) {
  try {
    const res = await fetch(`${BASE}/user/subscription`, {
      headers: { 'xi-api-key': key },
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    const used = Number(data?.character_count);
    const limit = Number(data?.character_limit);
    if (!Number.isFinite(used) || !Number.isFinite(limit)) return undefined;
    return { used, limit, tier: typeof data?.tier === 'string' ? data.tier : undefined };
  } catch {
    return undefined;
  }
}
