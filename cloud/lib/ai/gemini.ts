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

export async function writeProse(prompt: string): Promise<BriefProse> {
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
        responseSchema: BRIEF_SCHEMA,
        temperature: 0,
        maxOutputTokens: 700,
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

  const parsed = JSON.parse(text);
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
