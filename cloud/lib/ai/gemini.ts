import 'server-only';

/* The site's one model call.
 *
 * A deliberate port of GeminiProvider in athena/ai/cloud.py, not a new design:
 * same endpoint, same JSON-schema-constrained decoding, same rule that the
 * model writes prose and never produces a number. Keeping the two the same
 * means a brief written here reads like a brief written by the desktop app.
 *
 * WHAT LEAVES THIS SERVER, stated plainly because a demo that quietly ships
 * user data to a vendor is the thing worth refusing to build: a few hundred
 * tokens of ALREADY-AGGREGATED counts -- "42 invoices, 3 authors, 2023-2025".
 * No file content, because the catalogue has none: the seed holds names, sizes,
 * dates and tag ids and nothing else. No paths, no file names, no user
 * identity. The digest is assembled in lib/brief/digest.ts and is the entire
 * payload.
 *
 * `server-only` is load-bearing. An accidental import from a client component
 * would put the key in the browser bundle, and this file failing the build is
 * how that gets caught rather than shipped.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/* Overridable because model ids move faster than deploys do -- and verified
 * against models.list rather than copied from the engine, which still carried
 * `gemini-3.1-flash`: a plausible-looking id that Google does not publish, and
 * therefore a 404 on the first real call.
 *
 * The lite tier is the right default for this workload: a few hundred tokens
 * of counts in, at most 700 of prose out, on a shared key. */
export const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

/* The response shape, mirroring ANALYSIS_SCHEMA in athena/ai/base.py. Gemini
 * rejects `additionalProperties`, which is why the Python side filters it out
 * of the shared schema; here the schema is written without it to begin with. */
const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description: 'Two or three sentences describing what this set of files is.',
    },
    topics: {
      type: 'array',
      items: { type: 'string' },
      description: 'Recurring themes across the set. Lowercase, at most five.',
    },
    objects: {
      type: 'array',
      items: { type: 'string' },
      description: 'The subjects or projects these are mostly about. At most six.',
    },
  },
  required: ['description', 'topics', 'objects'],
} as const;

export interface BriefProse {
  description: string;
  topics: string[];
  objects: string[];
  model: string;
}

export function geminiKey(): string | undefined {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  return key && key.trim() ? key.trim() : undefined;
}

/** Presence only, never the value -- this is what /api/health reports. */
export function geminiStatus(): { configured: boolean; model: string; reason?: string } {
  return geminiKey()
    ? { configured: true, model: MODEL }
    : { configured: false, model: MODEL, reason: 'GEMINI_API_KEY is not set' };
}

export class GeminiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GeminiError';
  }
}

const TIMEOUT_MS = 20_000;

/* One schema-constrained call.
 *
 * Split out of writeProse when the agent needed the same plumbing with a
 * different schema. Everything that is a property of HOW this server talks to
 * Gemini lives here -- the key in a header, temperature 0, the timeout, the
 * finishReason unwrapping -- so a second caller cannot get any of it subtly
 * wrong. */
export async function generate(
  prompt: string,
  schema: unknown,
  maxOutputTokens: number,
): Promise<unknown> {
  const key = geminiKey();
  if (!key) throw new GeminiError('GEMINI_API_KEY is not set');

  const res = await fetch(`${BASE}/${MODEL}:generateContent`, {
    method: 'POST',
    // The key goes in a header, not the query string. A URL with a key in it
    // ends up in logs, proxies and error messages; a header does not.
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0,
        maxOutputTokens,
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new GeminiError(`Gemini returned ${res.status}: ${detail}`, res.status);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') {
    // A blocked or truncated response has candidates but no text part, and
    // reporting the finishReason is the difference between a fixable message
    // and "something went wrong".
    const why = data?.candidates?.[0]?.finishReason ?? data?.promptFeedback?.blockReason;
    throw new GeminiError(`Gemini returned no text${why ? ` (${why})` : ''}`);
  }

  return JSON.parse(text);
}

export async function writeProse(prompt: string): Promise<BriefProse> {
  const parsed = (await generate(prompt, BRIEF_SCHEMA, 700)) as Record<string, unknown>;
  const clean = (v: unknown, limit: number) =>
    (Array.isArray(v) ? v : [])
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim())
      .slice(0, limit);

  return {
    description: String(parsed?.description ?? '').trim(),
    topics: clean(parsed?.topics, 5),
    objects: clean(parsed?.objects, 6),
    model: MODEL,
  };
}

/* Does Google accept this key, from this server, right now?
 *
 * models.list rather than generateContent: it needs the same credential, is
 * free, and cannot be turned into a way to spend the key by hitting the health
 * endpoint in a loop.
 *
 * The message is passed through verbatim because Google's 400s are unusually
 * good -- "API key not valid" and "API key expired" are different problems with
 * different fixes, and collapsing them into "AI unavailable" throws the useful
 * half away. The KEY is never echoed, only Google's verdict on it. */
/* A fingerprint, not the key.
 *
 * When a credential works from a laptop and is refused from a lambda, the
 * boring explanation is almost always that the two are not the same string --
 * a truncated paste, a trailing newline, a smart quote picked up on the way
 * through a dialog box. That is invisible from the outside and impossible to
 * check against a secret you cannot read back.
 *
 * Length plus the first three and last four characters settles it, and gives
 * away seven characters of a fifty-three character key: enough to compare two
 * copies, not enough to reconstruct one. `clean` is the field that actually
 * catches the common case. */
function fingerprint(key: string): {
  length: number; starts: string; ends: string; clean: boolean;
} {
  return {
    length: key.length,
    starts: key.slice(0, 3),
    ends: key.slice(-4),
    // Vercel does not always trim, and an invisible character is the single
    // most likely reason a correct-looking key is rejected.
    clean: key === key.trim() && !/["'\s]/.test(key),
  };
}

export async function probeGemini(): Promise<{
  ok: boolean; model: string; status?: number; detail?: string;
  key?: ReturnType<typeof fingerprint>;
}> {
  const raw = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  const key = geminiKey();
  if (!key) return { ok: false, model: MODEL, detail: 'GEMINI_API_KEY is not set' };
  const print = fingerprint(raw);

  try {
    const res = await fetch(`${BASE}?pageSize=1`, {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    if (res.ok) return { ok: true, model: MODEL, status: res.status, key: print };

    const body = await res.text();
    const message = (() => {
      try { return JSON.parse(body)?.error?.message; } catch { return undefined; }
    })();
    return {
      ok: false, model: MODEL, status: res.status,
      detail: (message ?? body).slice(0, 200), key: print,
    };
  } catch (err) {
    return {
      ok: false, model: MODEL, key: print,
      detail: err instanceof Error ? err.message.slice(0, 200) : 'request failed',
    };
  }
}
