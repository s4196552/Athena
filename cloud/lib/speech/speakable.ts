/* Turning what the app says into something worth hearing.
 *
 * Three things get read aloud, and they arrive in three different shapes: the
 * brief (markdown), an explanation of one file (a record with a caveat list),
 * and a view plan (a filter with a reason). Each gets its own translator below
 * and they all end at the same cap, because they all end at the same bill.
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

/* Drops the marks that only mean something on a screen.
 *
 * `**bold**` is emphasis a voice cannot carry, and the digits inside it
 * survive either way.
 *
 * The underscore is the one worth arguing for, because it is not a mark at all
 * -- it is a WORD BOUNDARY that a filesystem forced someone to spell
 * differently. A synthesiser reads "Art_Assets" as "art underscore assets" or
 * as one run-on word, and neither is what was written; "Art Assets" is. The
 * same reasoning as the em dash in a count row, and it matters more here,
 * because paths and file names turn up inside the model's own sentences where
 * nothing else would catch them.
 *
 * It stops at the underscore. A slash is left alone, because "slash" is an
 * accurate reading of a path and dropping it would join two folder names into
 * one that does not exist. */
function inline(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/_/g, ' ')
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

/* ===========================================================================
 *  THE AGENT'S ANSWERS.
 *
 *  Both of the agent's model-backed verbs produce an answer with a CAVEAT
 *  attached, and the caveat is the reason each of them is safe to show at all.
 *  An explanation carries `unknowns` -- what the model could not determine,
 *  because it never opened the file. A plan carries `dropped` -- the parts of
 *  the question that matched no label here and were left out rather than
 *  guessed at.
 *
 *  On screen those are printed as prominently as the answer. In audio they are
 *  easier to lose, because a reading that runs long simply stops, and what it
 *  stops before is the end -- which is exactly where a caveat naturally sits.
 *  A reading that delivered a confident description of a file nobody opened
 *  and then ran out of characters before mentioning that nobody opened it
 *  would be strictly worse than the screen it is reading from.
 *
 *  So the parts are marked, and the cap is applied by DROPPING the optional
 *  ones rather than by cutting the tail. The caveat survives at the expense of
 *  the evidence list, which is the right trade in both directions: evidence
 *  you cannot hear is still on the screen, and a limit you cannot hear is a
 *  limit you do not know about.
 * ========================================================================= */

interface Part {
  text: string;
  /** False if this part may be dropped whole to fit the cap. */
  essential: boolean;
}

function assemble(parts: Part[]): Speakable {
  const join = (list: Part[]) =>
    list.map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim();

  const present = parts.filter((p) => p.text.trim());
  const full = join(present);
  if (full.length <= MAX_SPEECH_CHARS) {
    return { text: full, chars: full.length, truncated: false };
  }

  // Optional parts go last-first: the reading loses its least load-bearing
  // clause before it loses a word of anything else.
  const kept = [...present];
  for (let i = kept.length - 1; i >= 0 && join(kept).length > MAX_SPEECH_CHARS; i--) {
    if (!kept[i].essential) kept.splice(i, 1);
  }

  /* The hard cut is a backstop, not a strategy. Every essential part below is
     individually bounded -- a summary is capped at 900 characters by
     explain.ts, a reason at 400 by view.ts, the lists by count -- so their sum
     cannot reach the cap. If this line ever fires, one of those bounds has
     been raised without anyone checking what it feeds. */
  const cut = truncate(join(kept), MAX_SPEECH_CHARS);
  return { text: cut, chars: cut.length, truncated: true };
}

/** A list of clauses, spoken as one. Semicolons between the items and commas
 *  inside them, for the reason speakBody gives about count rows: commas
 *  throughout run the end of one item into the start of the next. */
function clauses(items: string[], limit: number, each = 200): string {
  const kept = items
    .map((i) => inline(i).slice(0, each))
    .filter(Boolean)
    .slice(0, limit);
  return kept.join('; ');
}

export interface SpeakableFile {
  name: string;
  ext: string;
}

/* A file name is written for a filesystem, not for a voice. "Q3_Report_v2.pdf"
 * read literally is "Q three underscore report underscore v two dot p d f",
 * which is the same category of mistake as reading "###" aloud. Separators
 * become spaces, and the extension is lifted out and named rather than
 * trailing after a dot.
 *
 * THE TYPE GOES FIRST -- "the SVG file logos rigging 420" rather than "logos
 * rigging 420, an SVG file" -- and that is a grammar decision, not a stylistic
 * one. Trailing it needs an indefinite article, and whether an extension takes
 * "a" or "an" depends on how it is PRONOUNCED: an SVG but a PDF, an MP3 but a
 * JPEG, and "a MOV" despite the M, because that one is said as a word. There
 * is no rule available here that gets all of those right, and a reading that
 * says "a SVG" sounds like a machine. "The" is correct in front of every one
 * of them, and it front-loads the thing a listener most wants first anyway.
 *
 * The name itself is left alone beyond the separators. Case survives and
 * nothing is expanded, because a name is the one string in this app that is
 * data rather than presentation -- an "IMG" helpfully spoken as "image" would
 * be this module inventing a fact about a file, which is exactly what the rest
 * of the feature refuses to do. */
function spokenName(file: SpeakableFile): string {
  const ext = file.ext.replace(/^\./, '');
  const stem = ext && file.name.toLowerCase().endsWith(`.${ext.toLowerCase()}`)
    ? file.name.slice(0, -(ext.length + 1))
    : file.name;

  const words = stem.replace(/_+/g, ' ').replace(/-+/g, ' ').replace(/\s+/g, ' ').trim();
  const spoken = words || file.name;
  return ext ? `the ${ext.toUpperCase()} file ${spoken}` : spoken;
}

/* The spoken register for confidence, which is not the written one.
 *
 * FileInsight prints these as a byline under the answer -- a fragment, after a
 * dot, where the reader can see it belongs to the summary above. Spoken there
 * is no "above", so each one has to be a sentence that says what it is about.
 * The same information in the shape its medium needs, which is the whole
 * premise of this module. */
const CONFIDENCE_SPOKEN: Record<'high' | 'medium' | 'low', string> = {
  high: 'Confidence is high: the name and labels say so outright.',
  medium: 'Confidence is medium: this is consistent with the folder and its neighbours.',
  low: 'Confidence is low: this is a reading of a generic name.',
};

export interface ExplanationLike {
  summary: string;
  reads: string[];
  unknowns: string[];
  confidence: 'high' | 'medium' | 'low';
}

export function speakableExplanation(
  file: SpeakableFile,
  explanation: ExplanationLike,
): Speakable {
  const summary = inline(explanation.summary);
  if (!summary) return { text: '', chars: 0, truncated: false };

  const reads = clauses(explanation.reads, 4);
  const unknowns = clauses(explanation.unknowns, 3);

  return assemble([
    { text: sentence(`About ${inline(spokenName(file))}`), essential: true },
    { text: sentence(summary), essential: true },
    // The evidence is the droppable half. It is corroboration for a claim the
    // listener has already heard, and all of it is on the screen.
    { text: reads ? `It reads that from: ${reads}.` : '', essential: false },
    /* Never dropped. This is the sentence that makes the one before it safe to
       believe, and a description of a file nobody opened is only honest while
       its limits are attached to it. */
    {
      text: unknowns
        ? `It cannot tell you, without opening the file itself: ${unknowns}.`
        : 'It cannot tell you anything that is actually inside the file.',
      essential: true,
    },
    { text: CONFIDENCE_SPOKEN[explanation.confidence], essential: true },
  ]);
}

export interface PlanLike {
  mode: 'files' | 'tags' | 'pyramid';
  tags: Record<string, string[]>;
  q?: string;
  title: string;
  why: string;
  dropped: { axis: string; name: string }[];
}

/* What each drawing IS, in a clause a listener can picture. The graph sidebar
 * can afford a legend; a reading cannot, so "tags" has to become the thing it
 * draws rather than the name of a mode. */
const MODE_SPOKEN: Record<PlanLike['mode'], string> = {
  files: 'drawn as a field of files, pulled together by the labels they share',
  tags: 'drawn as a web of labels, joined where files carry both',
  pyramid: 'drawn as a hierarchy, with the broad labels above the narrower ones',
};

export function speakablePlan(
  plan: PlanLike,
  matches: number,
  axisLabel: (kind: string) => string,
): Speakable {
  /* THE COUNT IS ARITHMETIC, and saying it out loud is most of the value of
     hearing this at all. The model chose the filter; the catalogue counted the
     result, and this sentence is the catalogue's, not the model's. */
  const count = matches === 1
    ? 'One file matches.'
    : `${matches.toLocaleString('en-US')} files match.`;

  const axes = Object.entries(plan.tags)
    .filter(([, names]) => names.length)
    .map(([axis, names]) => `${axisLabel(axis).toLowerCase()} ${names.join(' or ')}`);
  if (plan.q) axes.push(`names containing "${inline(plan.q)}"`);

  const filter = axes.length
    ? `Filtered to ${axes.join(', and ')}, ${MODE_SPOKEN[plan.mode]}.`
    : `Nothing is filtered out, ${MODE_SPOKEN[plan.mode]}.`;

  /* Never dropped, for the same reason the unknowns are not. A question that
     was half understood must not sound like one that was understood. */
  const dropped = plan.dropped.length
    ? `It ignored ${plan.dropped.slice(0, 4).map((d) => `"${inline(d.name).slice(0, 60)}"`).join(', ')}`
      + `${plan.dropped.length > 4 ? ` and ${plan.dropped.length - 4} more` : ''}`
      + ': there is no such label in this library, so it was left out rather than guessed at.'
    : '';

  return assemble([
    { text: sentence(`Showing: ${inline(plan.title)}`), essential: true },
    { text: count, essential: true },
    { text: filter, essential: true },
    // The model's reasoning. Useful, and the first thing to go under pressure:
    // the filter above is what it actually did, and that is already said.
    { text: plan.why ? sentence(inline(plan.why)) : '', essential: false },
    { text: dropped, essential: true },
  ]);
}
