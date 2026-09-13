/* Turning a brief into something worth hearing.
 *
 * The brief is markdown built by lib/brief/compile.ts, and it is built for
 * EYES: headings to skim, a right-aligned count column, em dashes doing the
 * work of a table. Handed to a speech synthesiser verbatim it comes out as
 * "hash hash hash what these are dash invoice em dash forty two", which is not
 * a worse reading of the brief so much as a reading of a different document.
 *
 * So the grammar is translated rather than stripped. It is a closed grammar --
 * compileBrief emits exactly four constructs and this module is the only thing
 * that consumes them -- which is why a real markdown parser would be the wrong
 * tool here for the second time in this codebase (BriefPanel's renderer says
 * the same about rendering it).
 *
 * Pure, and separate from the route, so the awkward cases can be asserted
 * without a network or a key: scripts/check-speakable.mts.
 */

/* Two thousand characters is roughly two and a half minutes of speech, and
 * about where a spoken summary stops being a summary. It is also the per-call
 * cost ceiling -- lib/speech/budget.ts counts characters because that is what
 * ElevenLabs bills, so this constant is the price of one press of Listen. */
export const MAX_SPEECH_CHARS = 2_000;

export interface Speakable {
  text: string;
  chars: number;
  /** True when the brief was longer than the cap and the reading stops early.
   *  Surfaced in the UI rather than swallowed: audio that ends mid-summary
   *  without saying so reads as a bug in the player. */
  truncated: boolean;
}

interface BriefLike {
  title: string;
  body: string;
  intro?: string;
}

export function speakableBrief(brief: BriefLike): Speakable {
  const parts: string[] = [];

  // The title is a sentence already -- "42 invoice files, mostly finance" --
  // so it opens the reading as one.
  if (brief.title.trim()) parts.push(sentence(inline(brief.title)));

  // The model's paragraph, when there is one, comes before the counts. It says
  // what the set IS, which is the part a listener needs in order to have
  // somewhere to put the numbers that follow.
  if (brief.intro?.trim()) parts.push(sentence(inline(brief.intro)));

  parts.push(...speakBody(brief.body));

  const full = parts.join(' ').replace(/\s+/g, ' ').trim();
  const cut = truncate(full, MAX_SPEECH_CHARS);
  return { text: cut, chars: cut.length, truncated: cut.length < full.length };
}

function speakBody(body: string): string[] {
  const out: string[] = [];
  let heading = '';
  let items: string[] = [];

  const flush = () => {
    if (!items.length) return;
    // "What these are: invoice, 42; report, 18." A semicolon between rows and
    // a comma inside one is what keeps a list of pairs parseable by ear --
    // commas throughout would run the name of one row into the count of the
    // last.
    out.push(`${heading ? `${heading}: ` : ''}${items.join('; ')}.`);
    items = [];
    heading = '';
  };

  for (const raw of body.split('\n')) {
    const text = raw.trim();

    if (!text) {
      flush();
      continue;
    }

    if (text.startsWith('### ')) {
      flush();
      heading = inline(text.slice(4));
      continue;
    }

    if (text.startsWith('- ')) {
      const item = inline(text.slice(2));
      // "invoice — 42" is a row of a table. Spoken, the em dash is silence;
      // a comma is the pause a listener already knows how to read.
      const at = item.lastIndexOf(' — ');
      items.push(at === -1 ? item : `${item.slice(0, at)}, ${item.slice(at + 3)}`);
      continue;
    }

    // A plain paragraph. If a heading is still open it belongs to this
    // paragraph rather than to a list -- "When: 2024 (12), 2023 (8)."
    const line = inline(text);
    if (heading) {
      out.push(sentence(`${heading}: ${line}`));
      heading = '';
    } else {
      out.push(sentence(line));
    }
  }

  flush();
  return out;
}

/** Drops the marks that only mean something on a screen. `**bold**` is
 *  emphasis a voice cannot carry, and the digits inside it survive either way. */
function inline(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Guarantees the terminal stop a synthesiser needs to fall in pitch at the
 *  end of a clause. Without it every line runs into the next. */
function sentence(text: string): string {
  if (!text) return '';
  return /[.!?:;]$/.test(text) ? text : `${text}.`;
}

/* Cut on a sentence boundary, not a character.
 *
 * A hard slice ends the audio mid-word, which sounds like the connection
 * dropped rather than like the summary ran long. Falling back to a word
 * boundary covers the case where the cap lands inside one very long sentence,
 * and the hard slice is the last resort for text with no spaces at all. */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const window = text.slice(0, limit);

  const stop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
  if (stop > limit * 0.6) return window.slice(0, stop + 1);

  const space = window.lastIndexOf(' ');
  return space > 0 ? `${window.slice(0, space)}.` : window;
}
