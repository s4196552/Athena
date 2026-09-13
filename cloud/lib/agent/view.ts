import 'server-only';
import { generate, MODEL } from '../ai/gemini';
import { TAG_AXES } from '../taxonomy';

/* TURNING A QUESTION INTO A VIEW.
 *
 * "Show me how finance and legal overlap" becomes a tag graph filtered to two
 * topics; "what did Aria Chen work on in 2024" becomes a file graph filtered
 * to an author and a year. The model's entire job is that translation.
 *
 * IT DOES NOT ANSWER THE QUESTION. It picks a filter and a drawing mode, and
 * then the catalogue answers, by the same code path the facet rail uses. This
 * is the split the whole app is built on -- compileBrief says it too: every
 * number is arithmetic over the index, and the model's contribution is knowing
 * what to count, never what the count is. A model that reported "about 400
 * files" would be recalling a plausible number; this one produces a filter and
 * gets told 387.
 *
 * The model may only choose from names the library actually uses. A tag it
 * invents cannot be matched, so an unvalidated pick would silently produce an
 * empty view that looks like a real answer -- the failure mode where the app
 * appears to work and is wrong. Every name is checked against the offered
 * vocabulary and anything unrecognised is DROPPED AND REPORTED, so the person
 * can see the question was partly understood rather than wondering why the
 * result looks odd.
 *
 * WHAT LEAVES THE SERVER: the question as typed, and the list of tag names the
 * library uses. No file names, no counts, no user identity.
 */

export type GraphMode = 'files' | 'tags' | 'pyramid';

const MODES: GraphMode[] = ['files', 'tags', 'pyramid'];

/** Values offered per axis. The seeded catalogue has 103 keywords alone, and a
 *  prompt listing every one of them would be mostly vocabulary. The most-used
 *  values are the ones a question is likely to be about. */
const PER_AXIS = 40;

const SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: MODES,
      description: 'Which drawing best answers the question.',
    },
    filters: {
      type: 'array',
      description: 'The tags to filter to. Use names EXACTLY as offered.',
      items: {
        type: 'object',
        properties: {
          axis: { type: 'string', description: 'One of the axis names offered.' },
          name: { type: 'string', description: 'One of the values offered on that axis.' },
        },
        required: ['axis', 'name'],
      },
    },
    q: {
      type: 'string',
      description:
        'A word to match against file names, when the question names something '
        + 'that is not a tag. Empty when the tags already cover it.',
    },
    title: {
      type: 'string',
      description: 'A short label for this view, at most eight words.',
    },
    why: {
      type: 'string',
      description: 'One sentence on why this filter and this mode answer the question.',
    },
  },
  required: ['mode', 'filters', 'q', 'title', 'why'],
} as const;

export interface ViewPlan {
  mode: GraphMode;
  /** Axis -> names, in the shape FileQuery.tags wants. */
  tags: Record<string, string[]>;
  q?: string;
  title: string;
  why: string;
  /** Names the model asked for that the library does not have. Shown, never
   *  swallowed: a partly-understood question must not look like a whole one. */
  dropped: { axis: string; name: string }[];
  model: string;
}

export type Vocabulary = Record<string, { name: string; display: string; count: number }[]>;

export function viewPrompt(question: string, vocab: Vocabulary): string {
  const axes = TAG_AXES.filter((a) => vocab[a.kind]?.length);

  return [
    'You are turning a question about a file library into a VIEW of it: a',
    'filter, plus which of three drawings to show.',
    '',
    'You are not answering the question. You choose what to look at; the',
    'library then counts it. Do not state any quantity -- you have not been',
    'given one and any number you produce would be invented.',
    '',
    `The question: ${question}`,
    '',
    'The three modes:',
    '- files: every matching file is a dot, pulled together by the labels they',
    '  share. Use it for "show me", "what did X work on", "find".',
    '- tags: every label is a dot, joined when files carry both. Use it for',
    '  "how do these relate", "what goes with what", "overlap", "connection".',
    '- pyramid: labels arranged as a hierarchy, broad ones above the narrower',
    '  ones they contain. Use it for "structure", "what is under", "break down".',
    '',
    'Filter using ONLY these names, exactly as written. Values on the same',
    'axis widen the selection (either one matches); different axes narrow it',
    '(both must match).',
    '',
    ...axes.map((a) => {
      const values = vocab[a.kind].slice(0, PER_AXIS);
      return `${a.kind} (${a.label}): ${values.map((v) => v.name).join(', ')}`;
    }),
    '',
    'If the question names something that is not on those lists -- a project,',
    'a file name, a word -- put it in q instead of inventing a tag for it.',
    'If the question is broad ("show me everything"), return no filters at all;',
    'an unfiltered view is a valid answer and better than a wrong narrow one.',
    '',
    'Keep title short and plain. In why, name the axis and mode you chose and',
    'what made you choose them.',
  ].join('\n');
}

export async function planView(question: string, vocab: Vocabulary): Promise<ViewPlan> {
  const raw = (await generate(viewPrompt(question, vocab), SCHEMA, 400)) as Record<string, unknown>;

  const mode = MODES.includes(String(raw?.mode) as GraphMode)
    ? (String(raw.mode) as GraphMode)
    : 'files';

  /* Validated against the offered vocabulary rather than trusted. A schema
     constrains the SHAPE of the answer, not its contents: `enum` on the mode
     is enforced, but a free-string tag name is not, and an unmatched name
     would filter to nothing while looking like a considered choice. */
  const tags: Record<string, string[]> = {};
  const dropped: { axis: string; name: string }[] = [];
  const known = new Set(TAG_AXES.map((a) => a.kind));

  for (const entry of Array.isArray(raw?.filters) ? raw.filters : []) {
    const axis = String((entry as Record<string, unknown>)?.axis ?? '').trim().toLowerCase();
    const name = String((entry as Record<string, unknown>)?.name ?? '').trim().toLowerCase();
    if (!axis || !name) continue;

    if (!known.has(axis) || !vocab[axis]) {
      dropped.push({ axis: axis || '(none)', name });
      continue;
    }

    const match = vocab[axis].find((v) => v.name.toLowerCase() === name);
    if (!match) {
      dropped.push({ axis, name });
      continue;
    }

    const list = tags[axis] ?? (tags[axis] = []);
    if (!list.includes(match.name)) list.push(match.name);
  }

  const q = String(raw?.q ?? '').trim().slice(0, 80);

  return {
    mode,
    tags,
    q: q || undefined,
    title: String(raw?.title ?? '').trim().slice(0, 80) || 'This view',
    why: String(raw?.why ?? '').trim().slice(0, 400),
    dropped,
    model: MODEL,
  };
}
