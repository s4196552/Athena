import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { workspaceContext } from '@/lib/data/context';
import { produceBrief, selectionKey } from '@/lib/brief/produce';
import { speakableBrief } from '@/lib/speech/speakable';
import {
  cachedAudio,
  checkSpeechBudget,
  rememberAudio,
  spendSpeech,
} from '@/lib/speech/budget';
import { SPEECH_MIME, SpeechError, elevenLabsKey, speak } from '@/lib/ai/elevenlabs';

/* Reads the brief for a selection aloud.
 *
 * A route handler rather than a server action because the answer is forty
 * kilobytes of mp3. A server action would have to base64 it into the RSC
 * stream -- a third larger, buffered as a string, and unplayable until the
 * whole payload lands. A route returns bytes with a media type, which is what
 * an <audio> element wants.
 *
 * THE REQUEST CARRIES A FILTER, NOT TEXT. `{ query: "tags.topic=finance" }`,
 * the same string the library page is already using, and the brief is rebuilt
 * here from the catalogue. lib/ai/elevenlabs.ts explains why at length: an
 * endpoint that speaks what it is posted is a free speech service for anyone
 * who can reach the login screen, billed to one shared key, and a length cap
 * does not fix it because the abuse is unlimited calls of legal length.
 *
 * Rebuilding is also nearly free -- `cached-only` means no model call ever
 * happens on this path, so the cost of the rebuild is a catalogue scan the
 * library page does on every request anyway.
 */

export async function POST(
  request: Request,
  { params }: { params: Promise<{ ws: string }> },
) {
  const { ws } = await params;

  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const ctx = await workspaceContext(session.user.id, ws);
  if (!ctx) return NextResponse.json({ error: 'not found' }, { status: 404 });

  if (!elevenLabsKey()) {
    return NextResponse.json(
      {
        error: 'No speech key is configured on this server, so summaries can be '
          + 'read but not heard.',
      },
      { status: 503 },
    );
  }

  // Only the filter is taken from the body, and only as a string. Anything
  // else a caller sends is ignored rather than merged.
  let query = '';
  try {
    const body = await request.json();
    if (typeof body?.query === 'string') query = body.query.slice(0, 2_000);
  } catch {
    // A malformed body means the whole library, which is a valid selection.
  }

  const brief = await produceBrief(ctx, query, { model: 'cached-only' });
  if (brief.files === 0) {
    return NextResponse.json(
      { error: 'Nothing matches this filter, so there is no summary to read.' },
      { status: 422 },
    );
  }

  const { text, chars, truncated } = speakableBrief(brief);
  if (!text) {
    return NextResponse.json({ error: 'There is no summary to read.' }, { status: 422 });
  }

  /* The cache is checked BEFORE the budget, deliberately. A replay costs
     ElevenLabs nothing, so charging a viewer for it would make pressing play
     twice more expensive than it is -- and the most common reason to press
     play again is that someone walked away during the first reading. */
  const key = `${selectionKey(ctx, query)}|${hash(text)}`;
  const hit = cachedAudio(key);
  if (hit) return audio(hit, chars, truncated, true);

  const budget = await checkSpeechBudget(chars);
  if (!budget.allowed) {
    return NextResponse.json({ error: budget.reason }, { status: 429 });
  }

  try {
    const bytes = await speak(text);
    await spendSpeech(chars);
    rememberAudio(key, bytes);
    return audio(bytes, chars, truncated, false);
  } catch (err) {
    // The vendor's own message is usually the useful one, the same judgement
    // the agent's actions make about Gemini: "quota_exceeded" and
    // "invalid_api_key" are different problems with different fixes.
    const detail = err instanceof SpeechError
      ? err.message
      : 'The speech service could not be reached.';
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}

function audio(bytes: ArrayBuffer, chars: number, truncated: boolean, cached: boolean) {
  return new Response(bytes, {
    headers: {
      'Content-Type': SPEECH_MIME,
      'Content-Length': String(bytes.byteLength),
      /* Never stored. The audio is derived from a workspace's brief, which is
         a tenancy-scoped thing, and a shared cache holding it keyed only by
         URL would serve one workspace's summary to another. The in-process
         cache above is keyed by workspace id and is not shared. */
      'Cache-Control': 'private, no-store',
      // So the player can say "this reading stops early" rather than letting
      // the audio simply end mid-summary, which reads as a broken player.
      'X-Speech-Chars': String(chars),
      'X-Speech-Truncated': truncated ? '1' : '0',
      'X-Speech-Cached': cached ? '1' : '0',
    },
  });
}

/** FNV-1a. Not a checksum anyone relies on -- it only has to make "the same
 *  text" and "different text" different cache keys within one process. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
