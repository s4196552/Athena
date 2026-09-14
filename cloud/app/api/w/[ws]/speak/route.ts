import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { workspaceContext } from '@/lib/data/context';
import { getRepository } from '@/lib/data';
import { lensTagIds } from '@/lib/data/lens';
import { produceBrief, selectionKey } from '@/lib/brief/produce';
import { explainKey, planKey, recallAnswer } from '@/lib/agent/recall';
import { TAG_AXES } from '@/lib/taxonomy';
import {
  speakableBrief,
  speakableExplanation,
  speakablePlan,
  type Speakable,
} from '@/lib/speech/speakable';
import {
  cachedAudio,
  checkSpeechBudget,
  rememberAudio,
  spendSpeech,
} from '@/lib/speech/budget';
import { SPEECH_MIME, SpeechError, elevenLabsKey, speak } from '@/lib/ai/elevenlabs';
import type { FileId } from '@/lib/data/types';

/* Reads what the app is showing aloud: a brief, or one of the agent's answers.
 *
 * A route handler rather than a server action because the answer is forty
 * kilobytes of mp3. A server action would have to base64 it into the RSC
 * stream -- a third larger, buffered as a string, and unplayable until the
 * whole payload lands. A route returns bytes with a media type, which is what
 * an <audio> element wants.
 *
 * THE REQUEST CARRIES A REFERENCE, NOT TEXT. Never text, in any of the three
 * shapes it accepts: a filter string, a file id, or a question. lib/ai/
 * elevenlabs.ts explains why at length -- an endpoint that speaks what it is
 * posted is a free speech service for anyone who can reach the login screen,
 * billed to one shared key, and a length cap does not fix it because the abuse
 * is unlimited calls of legal length. What differs between the three is how
 * the server gets the words back:
 *
 *   brief    REBUILT from the catalogue. It is arithmetic, so rebuilding is
 *            free and produces the same words. `cached-only` means no model
 *            call can happen on this path.
 *   explain  RECALLED from lib/agent/recall.ts. It came out of a model call,
 *            so it cannot be rebuilt -- only remembered.
 *   plan     RECALLED, the same way.
 *
 * The consequence for the two recalled shapes is that this route can answer
 * "I no longer have that" and MUST NOT paper over it by asking the model
 * again. A Listen button that silently spends a model call to regenerate prose
 * already rendered on the screen would be expensive and, worse, would
 * sometimes read the person different words than the ones they are looking at.
 * Saying so is honest, and the answer is one press away.
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

  /* Only the reference is taken from the body, and only as a string. Anything
     else a caller sends is ignored rather than merged -- in particular there
     is no field here that carries text to be spoken, and there must never be
     one. */
  let body: Record<string, unknown> = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // A malformed body means the whole library's brief, which is a valid ask.
  }
  const str = (name: string) => {
    const value = body[name];
    return typeof value === 'string' ? value.slice(0, 2_000) : '';
  };

  const kind = str('kind') || 'brief';

  let speech: Speakable;
  let scope: string;

  if (kind === 'brief') {
    const query = str('query');
    const brief = await produceBrief(ctx, query, { model: 'cached-only' });
    if (brief.files === 0) {
      return NextResponse.json(
        { error: 'Nothing matches this filter, so there is no summary to read.' },
        { status: 422 },
      );
    }
    speech = speakableBrief(brief);
    scope = `brief|${selectionKey(ctx, query)}`;
  } else if (kind === 'explain') {
    const fileId = str('fileId');
    if (!fileId) {
      return NextResponse.json({ error: 'No file was named.' }, { status: 400 });
    }

    /* The file is loaded through the repository, so a file id from another
       tenant resolves to nothing here exactly as it does everywhere else. The
       lens ids it yields are also half the recall key, which is why they are
       read from lib/data/lens.ts rather than assembled again: a key built two
       slightly different ways is a key that never matches. */
    const file = await getRepository().getFile(ctx, fileId as FileId);
    if (!file) {
      return NextResponse.json({ error: 'That file is not in this workspace.' }, { status: 404 });
    }

    const remembered = recallAnswer(
      explainKey(ctx.workspace.id, file.id, lensTagIds(ctx, file)),
    );
    if (remembered?.kind !== 'explain') return forgotten('description of this file');

    speech = speakableExplanation(
      { name: file.name, ext: file.ext },
      remembered.explanation,
    );
    scope = `explain|${ctx.workspace.id}|${file.id}`;
  } else if (kind === 'plan') {
    const question = str('question');
    if (!question.trim()) {
      return NextResponse.json({ error: 'No question was given.' }, { status: 400 });
    }

    const remembered = recallAnswer(planKey(ctx.workspace.id, question));
    if (remembered?.kind !== 'plan') return forgotten('answer to that question');

    speech = speakablePlan(
      remembered.plan,
      remembered.matches,
      (axisKind) => TAG_AXES.find((a) => a.kind === axisKind)?.label ?? axisKind,
    );
    scope = `plan|${planKey(ctx.workspace.id, question)}`;
  } else {
    return NextResponse.json({ error: 'There is nothing of that kind to read.' }, { status: 400 });
  }

  const { text, chars, truncated } = speech;
  if (!text) {
    return NextResponse.json({ error: 'There is nothing to read.' }, { status: 422 });
  }

  /* The cache is checked BEFORE the budget, deliberately. A replay costs
     ElevenLabs nothing, so charging a viewer for it would make pressing play
     twice more expensive than it is -- and the most common reason to press
     play again is that someone walked away during the first reading. */
  const key = `${scope}|${hash(text)}`;
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

/* The one failure this route has that the brief path does not: the words are
 * gone. Module memory does not survive a cold start, and on a platform that
 * starts instances freely that is an ordinary Tuesday rather than an outage.
 *
 * 409 rather than 404, because the answer is not missing so much as no longer
 * current here, and the message says the one thing worth knowing -- that
 * asking again is what fixes it, and that speech deliberately will not do that
 * on its own. */
function forgotten(what: string): NextResponse {
  return NextResponse.json(
    {
      error: `This server no longer has the agent's ${what} in memory. Ask again `
        + 'and it can be read aloud — listening never re-runs the model on its own, '
        + 'so it can only read an answer that is already on screen.',
    },
    { status: 409 },
  );
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
